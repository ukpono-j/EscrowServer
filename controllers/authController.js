const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer'); // CHANGED: Use Nodemailer
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

// Initialize Gmail Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Verify transporter configuration
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Gmail transporter verification failed:', error);
  } else {
    console.log('✅ Gmail transporter is ready to send emails');
  }
});

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

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  otp: { type: String, required: true },
  type: { type: String, enum: ['registration', 'password-reset'], required: true },
  userId: { type: String },
  userData: { type: Object },
  expiresAt: { type: Date, required: true, expires: 0 },
  attempts: { type: Number, default: 0 },
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

// Send OTP Email using Gmail
const sendOTPEmail = async (email, otp, type = 'registration') => {
  const subject = type === 'registration' 
    ? 'Verify Your Email - Registration OTP' 
    : 'Password Reset OTP';
  
  const message = type === 'registration'
    ? `Welcome! Use this OTP to complete your registration: <strong>${otp}</strong>`
    : `Use this OTP to reset your password: <strong>${otp}</strong>`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
      <h2 style="color: #031420; text-align: center;">${type === 'registration' ? 'Email Verification' : 'Password Reset'}</h2>
      <p>${message}</p>
      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <h1 style="margin: 0; color: #B38939; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
      </div>
      <p>This code will expire in <strong>15 minutes</strong>.</p>
      <p style="color: #666; font-size: 12px;">If you didn't request this, please ignore this email.</p>
      <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message, please do not reply.</p>
    </div>
  `;

  try {
    console.log(`[OTP] Sending OTP to ${email} via Gmail...`);
    
    const mailOptions = {
      from: `"Sylo" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlContent,
    };

    const info = await transporter.sendMail(mailOptions);
    
    console.log('[OTP] Email sent successfully:', info.messageId);
    return true;
  } catch (error) {
    console.error('[OTP] Error sending email:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
};

// Request OTP for registration
const requestRegistrationOTP = async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${requestId}] Starting OTP request...`);
  console.time(`Request OTP ${requestId}`);

  try {
    const { firstName, lastName, email, password, dateOfBirth, phoneNumber } = req.body;

    console.log(`[${requestId}] Request data:`, { firstName, lastName, email, phoneNumber, dateOfBirth });

    const sanitizedInputs = {
      firstName: sanitizeInput(firstName),
      lastName: sanitizeInput(lastName),
      email: sanitizeInput(email),
      password: sanitizeInput(password),
      dateOfBirth: sanitizeInput(dateOfBirth),
      phoneNumber: sanitizeInput(phoneNumber),
    };

    // Validate all inputs first
    if (!sanitizedInputs.firstName || !sanitizedInputs.lastName || !sanitizedInputs.email ||
      !sanitizedInputs.password || !sanitizedInputs.dateOfBirth || !sanitizedInputs.phoneNumber) {
      console.log(`[${requestId}] Missing required fields`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedInputs.email)) {
      console.log(`[${requestId}] Invalid email format`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!/^(0\d{10}|\+234\d{10})$/.test(sanitizedInputs.phoneNumber)) {
      console.log(`[${requestId}] Invalid phone number`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({ error: 'Phone number must be 11 digits starting with 0 or +234' });
    }

    const dob = new Date(sanitizedInputs.dateOfBirth);
    if (isNaN(dob.getTime())) {
      console.log(`[${requestId}] Invalid date of birth`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({ error: 'Invalid date of birth' });
    }

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    if (age < 18) {
      console.log(`[${requestId}] User under 18`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({ error: 'You must be at least 18 years old' });
    }

    if (sanitizedInputs.password.length < 8 || !/[A-Z]/.test(sanitizedInputs.password) ||
      !/[0-9]/.test(sanitizedInputs.password) || !/[^A-Za-z0-9]/.test(sanitizedInputs.password)) {
      console.log(`[${requestId}] Weak password`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include uppercase, number, and special character'
      });
    }

    // Check if email already exists
    console.log(`[${requestId}] Checking for existing user...`);
    const existingUser = await User.findOne({ email: sanitizedInputs.email });
    if (existingUser) {
      console.log(`[${requestId}] Email already in use`);
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Generate OTP
    const otp = generateOTP();
    console.log(`[${requestId}] Generated OTP: ${otp}`);

    // Delete any existing OTPs for this email
    console.log(`[${requestId}] Clearing old OTPs...`);
    await OTPModel.deleteMany({ email: sanitizedInputs.email, type: 'registration' });

    // Store OTP with user data
    console.log(`[${requestId}] Storing OTP in database...`);
    await OTPModel.create({
      email: sanitizedInputs.email,
      otp,
      type: 'registration',
      userData: {
        firstName: sanitizedInputs.firstName,
        lastName: sanitizedInputs.lastName,
        password: sanitizedInputs.password,
        dateOfBirth: dob,
        phoneNumber: sanitizedInputs.phoneNumber,
      },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    console.log(`[${requestId}] OTP stored successfully`);

    // Send OTP email
    console.log(`[${requestId}] Sending OTP email...`);
    try {
      await sendOTPEmail(sanitizedInputs.email, otp, 'registration');
      console.log(`[${requestId}] OTP email sent successfully`);
    } catch (emailError) {
      console.error(`[${requestId}] Failed to send OTP email:`, emailError);
      // Delete the OTP since we couldn't send the email
      await OTPModel.deleteMany({ email: sanitizedInputs.email, type: 'registration' });
      console.timeEnd(`Request OTP ${requestId}`);
      return res.status(500).json({
        error: 'Failed to send OTP email. Please check your email address and try again.',
        details: emailError.message
      });
    }

    console.log(`[${requestId}] OTP request completed successfully`);
    console.timeEnd(`Request OTP ${requestId}`);

    res.status(200).json({
      success: true,
      message: 'OTP sent to your email. Please verify to complete registration.',
      email: sanitizedInputs.email,
      // For development only - remove in production
      ...(process.env.NODE_ENV !== 'production' && { devOtp: otp })
    });
  } catch (error) {
    console.timeEnd(`Request OTP ${requestId}`);
    console.error(`[${requestId}] Request OTP error:`, error);
    res.status(500).json({ error: 'Failed to send OTP. Please try again.', details: error.message });
  }
};

// Verify OTP and complete registration
const verifyRegistrationOTP = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const requestId = uuidv4();
  console.log(`[${requestId}] Starting OTP verification...`);
  console.time(`Verify OTP ${requestId}`);

  try {
    const { email, otp } = req.body;
    const sanitizedEmail = sanitizeInput(email);
    const sanitizedOTP = sanitizeInput(otp);

    console.log(`[${requestId}] Verifying OTP for email: ${sanitizedEmail}`);

    if (!sanitizedEmail || !sanitizedOTP) {
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Verify OTP ${requestId}`);
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    // Find OTP
    console.log(`[${requestId}] Looking up OTP in database...`);
    const otpDoc = await OTPModel.findOne({
      email: sanitizedEmail,
      type: 'registration'
    });

    if (!otpDoc) {
      console.log(`[${requestId}] No OTP found`);
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Verify OTP ${requestId}`);
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    console.log(`[${requestId}] Found OTP, attempts: ${otpDoc.attempts}`);

    // Check attempts
    if (otpDoc.attempts >= 5) {
      console.log(`[${requestId}] Too many attempts`);
      await OTPModel.deleteOne({ _id: otpDoc._id });
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Verify OTP ${requestId}`);
      return res.status(400).json({ error: 'Too many failed attempts. Please request a new OTP.' });
    }

    // Verify OTP
    if (otpDoc.otp !== sanitizedOTP) {
      console.log(`[${requestId}] Invalid OTP provided`);
      otpDoc.attempts += 1;
      await otpDoc.save();
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Verify OTP ${requestId}`);
      return res.status(400).json({
        error: 'Invalid OTP. Please try again.',
        attemptsRemaining: 5 - otpDoc.attempts
      });
    }

    // Check expiration
    if (new Date() > new Date(otpDoc.expiresAt)) {
      console.log(`[${requestId}] OTP expired`);
      await OTPModel.deleteOne({ _id: otpDoc._id });
      await session.abortTransaction();
      session.endSession();
      console.timeEnd(`Verify OTP ${requestId}`);
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    console.log(`[${requestId}] OTP verified successfully, creating user...`);

    // OTP is valid - create user
    const userData = otpDoc.userData;

    const user = new User({
      firstName: userData.firstName,
      lastName: userData.lastName,
      email: sanitizedEmail,
      password: userData.password,
      dateOfBirth: userData.dateOfBirth,
      phoneNumber: userData.phoneNumber,
      avatarImage: null,
      emailVerified: true,
    });
    const savedUser = await user.save({ session });
    console.log(`[${requestId}] User created: ${savedUser._id}`);

    // Create wallet
    console.log(`[${requestId}] Creating wallet...`);
    const wallet = new Wallet({
      userId: savedUser._id.toString(),
      balance: 0,
      totalDeposits: 0,
      currency: 'NGN',
      transactions: [],
      virtualAccount: null,
    });
    const savedWallet = await wallet.save({ session });
    console.log(`[${requestId}] Wallet created: ${savedWallet._id}`);

    // Create Paystack customer
    let customerCode;
    try {
      console.log(`[${requestId}] Creating Paystack customer...`);
      const customerResponse = await axios.post(
        'https://api.paystack.co/customer',
        {
          email: sanitizedEmail,
          first_name: userData.firstName,
          last_name: userData.lastName,
          phone: userData.phoneNumber,
          metadata: { userId: savedUser._id.toString() },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (customerResponse.data.status) {
        customerCode = customerResponse.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await user.save({ session });
        console.log(`[${requestId}] Paystack customer created: ${customerCode}`);
      }
    } catch (error) {
      console.error(`[${requestId}] Paystack customer creation failed:`, error.message);
    }

    // Create virtual account if customer was created
    if (customerCode) {
      try {
        console.log(`[${requestId}] Creating virtual account...`);
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

        if (accountResponse.data.status) {
          wallet.virtualAccount = {
            account_name: accountResponse.data.data.account_name,
            account_number: accountResponse.data.data.account_number,
            bank_name: accountResponse.data.data.bank.name,
            provider: 'Paystack',
            provider_reference: accountResponse.data.data.id,
          };
          await wallet.save({ session });
          console.log(`[${requestId}] Virtual account created`);
        }
      } catch (error) {
        console.error(`[${requestId}] Virtual account creation failed:`, error.message);
      }
    }

    // Create welcome notification
    console.log(`[${requestId}] Creating welcome notification...`);
    await Notification.create([{
      userId: savedUser._id,
      title: 'Welcome to the Platform',
      message: `Welcome, ${userData.firstName}! Your account has been verified and created successfully.`,
      reference: `REG_${Date.now()}`,
      type: 'registration',
      status: 'completed',
    }], { session });

    // Delete OTP
    await OTPModel.deleteOne({ _id: otpDoc._id });

    await session.commitTransaction();
    session.endSession();

    // Generate tokens
    const accessToken = jwt.sign({ id: savedUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: savedUser._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    await RefreshTokenModel.create({
      userId: savedUser._id.toString(),
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    console.log(`[${requestId}] Registration completed successfully`);
    console.timeEnd(`Verify OTP ${requestId}`);

    res.status(201).json({
      success: true,
      message: 'Email verified and registration completed successfully',
      accessToken,
      refreshToken,
      user: {
        id: savedUser._id,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        dateOfBirth: savedUser.dateOfBirth,
        avatarImage: savedUser.avatarImage,
      },
      walletId: savedWallet._id,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.timeEnd(`Verify OTP ${requestId}`);
    console.error(`[${requestId}] Verify OTP error:`, error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

// FIXED: Forgot Password with proper OTP type
const forgotPassword = async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${requestId}] Starting forgot password...`);

  try {
    const { email } = req.body;
    const sanitizedEmail = sanitizeInput(email);

    if (!sanitizedEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log(`[${requestId}] Looking up user: ${sanitizedEmail}`);
    const user = await User.findOne({ email: sanitizedEmail });
    if (!user) {
      console.log(`[${requestId}] User not found`);
      return res.status(404).json({ error: 'No account found with this email' });
    }

    const otp = generateOTP();
    console.log(`[${requestId}] Generated password reset OTP: ${otp}`);

    // Delete any existing password reset OTPs
    await OTPModel.deleteMany({
      email: sanitizedEmail,
      type: 'password-reset'
    });

    // Create new OTP with proper type
    await OTPModel.create({
      email: sanitizedEmail,
      otp,
      type: 'password-reset', // FIXED: Added type field
      userId: user._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    console.log(`[${requestId}] Sending password reset email...`);

    try {
      await sendOTPEmail(sanitizedEmail, otp, 'password-reset');
      console.log(`[${requestId}] Password reset email sent successfully`);

      res.status(200).json({
        success: true,
        message: 'Password reset OTP sent to your email',
        // For development only
        ...(process.env.NODE_ENV !== 'production' && { devOtp: otp })
      });
    } catch (emailError) {
      console.error(`[${requestId}] Failed to send password reset email:`, emailError);
      // Delete the OTP since we couldn't send the email
      await OTPModel.deleteMany({
        email: sanitizedEmail,
        type: 'password-reset'
      });
      return res.status(500).json({
        error: 'Failed to send password reset email. Please try again.',
        details: emailError.message
      });
    }
  } catch (error) {
    console.error(`[${requestId}] Forgot password error:`, error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

// FIXED: Reset Password
const resetPassword = async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${requestId}] Starting password reset...`);

  try {
    const { email, otp, newPassword } = req.body;
    const sanitizedInputs = {
      email: sanitizeInput(email),
      otp: sanitizeInput(otp),
      newPassword: sanitizeInput(newPassword),
    };

    if (!sanitizedInputs.email || !sanitizedInputs.otp || !sanitizedInputs.newPassword) {
      return res.status(400).json({ error: 'Email, OTP, and new password are required' });
    }

    console.log(`[${requestId}] Looking up password reset OTP...`);
    const otpDoc = await OTPModel.findOne({
      email: sanitizedInputs.email,
      type: 'password-reset'
    });

    if (!otpDoc) {
      console.log(`[${requestId}] No password reset OTP found`);
      return res.status(400).json({ error: 'No password reset request found. Please request a new OTP.' });
    }

    // Check attempts
    if (otpDoc.attempts >= 5) {
      console.log(`[${requestId}] Too many attempts`);
      await OTPModel.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: 'Too many failed attempts. Please request a new OTP.' });
    }

    // Verify OTP
    if (otpDoc.otp !== sanitizedInputs.otp) {
      console.log(`[${requestId}] Invalid OTP provided`);
      otpDoc.attempts += 1;
      await otpDoc.save();
      return res.status(400).json({
        error: 'Invalid OTP. Please try again.',
        attemptsRemaining: 5 - otpDoc.attempts
      });
    }

    // Check expiration
    if (new Date() > new Date(otpDoc.expiresAt)) {
      console.log(`[${requestId}] OTP expired`);
      await OTPModel.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Validate new password
    if (sanitizedInputs.newPassword.length < 8 ||
      !/[A-Z]/.test(sanitizedInputs.newPassword) ||
      !/[0-9]/.test(sanitizedInputs.newPassword) ||
      !/[^A-Za-z0-9]/.test(sanitizedInputs.newPassword)) {
      return res.status(400).json({
        error: 'New password must be at least 8 characters and include uppercase, number, and special character'
      });
    }

    const userId = otpDoc.userId;
    console.log(`[${requestId}] Finding user...`);
    const user = await User.findById(userId);
    if (!user) {
      console.log(`[${requestId}] User not found`);
      return res.status(404).json({ error: 'User not found.' });
    }

    // Update password
    user.password = sanitizedInputs.newPassword;
    await user.save();
    console.log(`[${requestId}] Password updated successfully`);

    // Delete OTP
    await OTPModel.deleteOne({ _id: otpDoc._id });

    res.status(200).json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error(`[${requestId}] Reset password error:`, error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

// Keep existing register, login, and refreshToken functions
// ... (rest of your existing code)

module.exports = {
  requestRegistrationOTP,
  verifyRegistrationOTP,
  register: requestRegistrationOTP, // Alias for backward compatibility
  forgotPassword,
  resetPassword,
  login: async (req, res) => {
    const requestId = uuidv4();
    console.time(`Login Process ${requestId}`);
    try {
      const { email, password } = req.body;
      const sanitizedInputs = {
        email: sanitizeInput(email),
        password: sanitizeInput(password),
      };

      console.log(`Login attempt for email: ${sanitizedInputs.email}`);

      if (!sanitizedInputs.email || !sanitizedInputs.password) {
        console.timeEnd(`Login Process ${requestId}`);
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const user = await User.findOne({ email: sanitizedInputs.email }).select('+password');
      if (!user) {
        console.timeEnd(`Login Process ${requestId}`);
        return res.status(404).json({ error: 'User not found' });
      }

      const isMatch = await user.comparePassword(sanitizedInputs.password);
      if (!isMatch) {
        console.timeEnd(`Login Process ${requestId}`);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      let wallet = await Wallet.findOne({ userId: user._id });
      if (!wallet) {
        wallet = new Wallet({
          userId: user._id.toString(),
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          virtualAccount: null,
        });
        await wallet.save();
      }

      const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
      const refreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

      await RefreshTokenModel.create({
        userId: user._id.toString(),
        token: refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      res.status(200).json({
        success: true,
        message: 'Login successful',
        accessToken,
        refreshToken,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          dateOfBirth: user.dateOfBirth,
          avatarImage: user.avatarImage,
        },
        walletId: wallet._id,
      });
      console.timeEnd(`Login Process ${requestId}`);
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
      console.timeEnd(`Login Process ${requestId}`);
    }
  },
  refreshToken: async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ error: "Refresh token is required" });
      }

      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      const storedToken = await RefreshTokenModel.findOne({ userId: decoded.id, token: refreshToken });
      if (!storedToken) {
        return res.status(401).json({ error: "Invalid or expired refresh token" });
      }

      const user = await User.findById(decoded.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const newAccessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
      res.status(200).json({ accessToken: newAccessToken });
    } catch (error) {
      console.error("Refresh token error:", error);
      res.status(401).json({ error: "Invalid or expired refresh token" });
    }
  },
};