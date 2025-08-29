const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    console.log(`Retry attempt ${retryCount} for Paystack API at ${new Date().toISOString()}`);
    return retryCount * 2000;
  },
  retryCondition: (error) => {
    const isRetryable =
      error.code === 'ECONNABORTED' ||
      error.code === 'ERR_NETWORK' ||
      (error.response && error.response.status >= 500) ||
      (error.response && error.response.status === 429);
    console.log('Retry condition check:', {
      code: error.code,
      status: error.response?.status,
      isRetryable,
    });
    return isRetryable;
  },
});

let transporter;

const initializeTransporter = async () => {
  try {
    if (process.env.NODE_ENV === 'production') {
      transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        secure: process.env.EMAIL_SECURE === 'true',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
        debug: true, // Enable debug logs
        logger: true,
      });
    } else {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: testAccount.user, pass: testAccount.pass },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        debug: true, // Enable debug logs
        logger: true,
      });
      console.log('Ethereal account created:', { user: testAccount.user });
    }
    console.log('Transporter initialized:', {
      host: process.env.EMAIL_HOST || 'smtp.ethereal.email',
      port: process.env.EMAIL_PORT || 587,
      env: process.env.NODE_ENV,
    });
  } catch (error) {
    console.error('Error initializing transporter:', error);
    transporter = {
      sendMail: (mailOptions) => {
        console.warn('Using fake transporter due to initialization failure');
        return Promise.resolve({ messageId: 'fake-message-id' });
      },
    };
  }
};

// Initialize transporter on startup
initializeTransporter().catch((error) => {
  console.error('Failed to initialize transporter on startup:', error);
});

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  otp: { type: String, required: true },
  userId: { type: String, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
  createdAt: { type: Date, default: Date.now },
});

const OTPModel = mongoose.models.OTP || mongoose.model('OTP', otpSchema);

const refreshTokenSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const RefreshTokenModel = mongoose.models.RefreshToken || mongoose.model('RefreshToken', refreshTokenSchema);

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const sanitizeInput = (input) => {
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  });
};

exports.register = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const requestId = uuidv4();
  console.time(`Register Process ${requestId}`);
  try {
    const { firstName, lastName, email, password, dateOfBirth, phoneNumber } = req.body;
    const sanitizedInputs = {
      firstName: sanitizeInput(firstName),
      lastName: sanitizeInput(lastName),
      email: sanitizeInput(email),
      password: sanitizeInput(password),
      dateOfBirth: sanitizeInput(dateOfBirth),
      phoneNumber: sanitizeInput(phoneNumber),
    };

    if (!sanitizedInputs.firstName || !sanitizedInputs.lastName || !sanitizedInputs.email || !sanitizedInputs.password || !sanitizedInputs.dateOfBirth || !sanitizedInputs.phoneNumber) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedInputs.email)) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!/^(0\d{10}|\+234\d{10})$/.test(sanitizedInputs.phoneNumber)) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'Phone number must be 11 digits starting with 0 or +234' });
    }

    const dob = new Date(sanitizedInputs.dateOfBirth);
    if (isNaN(dob.getTime())) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'Invalid date of birth' });
    }
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    if (age < 18) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'You must be at least 18 years old' });
    }

    if (sanitizedInputs.password.length < 8 || !/[A-Z]/.test(sanitizedInputs.password) || !/[0-9]/.test(sanitizedInputs.password) || !/[^A-Za-z0-9]/.test(sanitizedInputs.password)) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, number, and special character' });
    }

    const existingUser = await User.findOne({ email: sanitizedInputs.email }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Register Process ${requestId}`);
      return res.status(400).json({ error: 'Email already in use' });
    }

    const otp = generateOTP();
    const user = new User({
      firstName: sanitizedInputs.firstName,
      lastName: sanitizedInputs.lastName,
      email: sanitizedInputs.email,
      password: sanitizedInputs.password,
      dateOfBirth: dob,
      phoneNumber: sanitizedInputs.phoneNumber,
      isVerified: false, // Enforce email verification
    });
    const savedUser = await user.save({ session });

    const wallet = new Wallet({
      userId: savedUser._id.toString(),
      balance: 0,
      totalDeposits: 0,
      currency: 'NGN',
      transactions: [],
      virtualAccount: null,
    });
    const savedWallet = await wallet.save({ session });

    let customerCode;
    try {
      const customerResponse = await axios.post(
        'https://api.paystack.co/customer',
        {
          email: sanitizedInputs.email,
          first_name: sanitizedInputs.firstName,
          last_name: sanitizedInputs.lastName,
          phone: sanitizedInputs.phoneNumber,
          metadata: { userId: savedUser._id.toString() },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!customerResponse.data.status) {
        throw new Error(customerResponse.data.message || 'Failed to create customer');
      }
      customerCode = customerResponse.data.data.customer_code;
    } catch (error) {
      await Notification.create({
        userId: savedUser._id,
        title: 'Account Setup Failed',
        message: 'Unable to create payment profile. Please update your profile to enable funding.',
        reference: `REG_${Date.now()}`,
        type: 'registration',
        status: 'failed',
      }, { session });
    }

    if (customerCode) {
      try {
        const accountResponse = await axios.post(
          'https://api.paystack.co/dedicated_account',
          { customer: customerCode, preferred_bank: 'wema-bank' },
          {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!accountResponse.data.status) {
          throw new Error(accountResponse.data.message || 'Failed to create virtual account');
        }

        wallet.virtualAccount = {
          account_name: accountResponse.data.data.account_name,
          account_number: accountResponse.data.data.account_number,
          bank_name: accountResponse.data.data.bank.name,
          provider: 'Paystack',
          provider_reference: accountResponse.data.data.id,
        };
        await wallet.save({ session });
      } catch (error) {
        await Notification.create({
          userId: savedUser._id,
          title: 'Account Setup Failed',
          message: 'Unable to create virtual account. Please update your profile to enable funding.',
          reference: `REG_${Date.now()}`,
          type: 'registration',
          status: 'failed',
        }, { session });
      }
    }

    await OTPModel.create({
      email: sanitizedInputs.email,
      otp,
      userId: savedUser._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }, { session });

    if (process.env.NODE_ENV !== 'production') {
      console.log('Dev OTP:', otp);
    } else {
      const msg = {
        from: process.env.FROM_EMAIL || 'noreply@escrowserver.com',
        to: sanitizedInputs.email,
        subject: 'Verify Your Email',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h2 style="color: #031420; text-align: center;">Email Verification</h2>
            <p>Please use the following OTP code to verify your email:</p>
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
              <h1 style="margin: 0; color: #B38939; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
            </div>
            <p>This code will expire in 15 minutes.</p>
            <p>If you didn't request this, please ignore this email or contact support.</p>
            <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message, please do not reply.</p>
          </div>
        `,
      };
      const info = await transporter.sendMail(msg);
      console.log('Verification email sent:', { messageId: info.messageId, to: sanitizedInputs.email });
    }

    await Notification.create({
      userId: savedUser._id,
      title: 'Welcome to the Platform',
      message: `Welcome, ${sanitizedInputs.firstName}! Your account has been created successfully. Please verify your email to log in.`,
      reference: `REG_${Date.now()}`,
      type: 'registration',
      status: 'completed',
    }, { session });

    await session.commitTransaction();
    session.endSession();

    const accessToken = jwt.sign({ id: savedUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: savedUser._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    await RefreshTokenModel.create({
      userId: savedUser._id.toString(),
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.status(201).json({
      success: true,
      message: 'User and wallet registered successfully. Please verify your email to log in.',
      accessToken,
      refreshToken,
      user: {
        id: savedUser._id,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        dateOfBirth: savedUser.dateOfBirth,
      },
      walletId: savedWallet._id,
    });
    console.timeEnd(`Register Process ${requestId}`);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.timeEnd(`Register Process ${requestId}`);
    if (error.code === 11000) {
      if (error.keyPattern?.email) {
        return res.status(400).json({ error: 'Email already in use', details: error.keyValue });
      }
      if (error.keyPattern?.userId) {
        return res.status(400).json({ error: 'Wallet already exists for this user', details: error.keyValue });
      }
      return res.status(400).json({ error: 'Database error: Duplicate key', details: error.keyValue });
    }
    console.error('Error in register:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const sanitizedEmail = sanitizeInput(email);
    const sanitizedPassword = sanitizeInput(password);

    const user = await User.findOne({ email: sanitizedEmail }).select('+password');
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const isMatch = await user.comparePassword(sanitizedPassword);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.isVerified === false) {
      return res.status(403).json({ error: 'Please verify your email first' });
    }
    const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
    await RefreshTokenModel.create({
      userId: user._id.toString(),
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    res.json({
      success: true,
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: { id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    });
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const sanitizedEmail = sanitizeInput(email);
    const sanitizedOtp = sanitizeInput(otp);

    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.isVerified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    const otpDoc = await OTPModel.findOne({ email: sanitizedEmail, otp: sanitizedOtp });
    if (!otpDoc) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    if (new Date() > new Date(otpDoc.expiresAt)) {
      await OTPModel.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    user.isVerified = true;
    await user.save();
    await OTPModel.deleteOne({ _id: otpDoc._id });

    const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    await RefreshTokenModel.create({
      userId: user._id.toString(),
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      accessToken,
      refreshToken,
      user: { id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    });
  } catch (error) {
    console.error('Error in verifyEmail:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    const sanitizedEmail = sanitizeInput(email);

    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.isVerified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    const otp = generateOTP();
    await OTPModel.deleteMany({ email: sanitizedEmail });
    await OTPModel.create({
      email: sanitizedEmail,
      otp,
      userId: user._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('Dev OTP:', otp);
      return res.status(200).json({
        success: true,
        message: 'OTP resent successfully',
        devMode: true,
        devOtp: otp,
      });
    }

    const msg = {
      from: process.env.FROM_EMAIL || 'noreply@escrowserver.com',
      to: sanitizedEmail,
      subject: 'Verify Your Email',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2 style="color: #031420; text-align: center;">Email Verification</h2>
          <p>Please use the following OTP code to verify your email:</p>
          <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
            <h1 style="margin: 0; color: #B38939; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
          </div>
          <p>This code will expire in 15 minutes.</p>
          <p>If you didn't request this, please ignore this email or contact support.</p>
          <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message, please do not reply.</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(msg);
    console.log('Verification email sent:', { messageId: info.messageId, to: sanitizedEmail });
    res.status(200).json({ success: true, message: 'OTP resent to your email' });
  } catch (error) {
    console.error('Error in resendVerification:', error);
    res.status(500).json({ error: 'Failed to resend OTP email' });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const sanitizedEmail = sanitizeInput(email);

    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email' });
    }

    const otp = generateOTP();
    await OTPModel.deleteMany({ email: sanitizedEmail });
    await OTPModel.create({
      email: sanitizedEmail,
      otp,
      userId: user._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('Dev OTP:', otp);
      return res.status(200).json({
        success: true,
        message: 'OTP generated successfully',
        devMode: true,
        devOtp: otp,
      });
    }

    const msg = {
      from: process.env.FROM_EMAIL || 'noreply@escrowserver.com',
      to: sanitizedEmail,
      subject: 'Password Reset OTP',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2 style="color: #031420; text-align: center;">Password Reset Request</h2>
          <p>We received a request to reset your password. Use the following OTP code to reset your password:</p>
          <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
            <h1 style="margin: 0; color: #B38939; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
          </div>
          <p>This code will expire in 15 minutes.</p>
          <p>If you didn't request a password reset, please ignore this email or contact support.</p>
          <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message, please do not reply.</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(msg);
    console.log('Password reset email sent:', { messageId: info.messageId, to: sanitizedEmail });
    res.status(200).json({ success: true, message: 'OTP sent to your email' });
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    res.status(500).json({ error: 'Failed to send OTP email' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const sanitizedInputs = {
      email: sanitizeInput(email),
      otp: sanitizeInput(otp),
      newPassword: sanitizeInput(newPassword),
    };

    const otpDoc = await OTPModel.findOne({ email: sanitizedInputs.email });
    if (!otpDoc) {
      return res.status(400).json({ error: 'No OTP request found. Please request a new OTP.' });
    }

    if (otpDoc.otp !== sanitizedInputs.otp) {
      return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }

    if (new Date() > new Date(otpDoc.expiresAt)) {
      await OTPModel.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    const userId = otpDoc.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (sanitizedInputs.newPassword.length < 8 || !/[A-Z]/.test(sanitizedInputs.newPassword) || !/[0-9]/.test(sanitizedInputs.newPassword) || !/[^A-Za-z0-9]/.test(sanitizedInputs.newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters and include uppercase, number, and special character' });
    }

    user.password = sanitizedInputs.newPassword;
    await user.save();
    await OTPModel.deleteOne({ _id: otpDoc._id });

    res.status(200).json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Error in resetPassword:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.refreshToken = async (req, res) => {
  const requestId = uuidv4();
  console.time(`Refresh Token Process ${requestId}`);
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      console.timeEnd(`Refresh Token Process ${requestId}`);
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const storedToken = await RefreshTokenModel.findOne({ userId: decoded.id, token: refreshToken });
    if (!storedToken) {
      console.timeEnd(`Refresh Token Process ${requestId}`);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      console.timeEnd(`Refresh Token Process ${requestId}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const newAccessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const newRefreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
    await RefreshTokenModel.deleteOne({ _id: storedToken._id });
    await RefreshTokenModel.create({
      userId: user._id.toString(),
      token: newRefreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.status(200).json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
    console.timeEnd(`Refresh Token Process ${requestId}`);
  } catch (error) {
    console.error('Refresh token error:', { message: error.message });
    res.status(401).json({ error: 'Invalid or expired refresh token' });
    console.timeEnd(`Refresh Token Process ${requestId}`);
  }
};