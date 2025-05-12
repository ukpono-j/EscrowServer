const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

let transporter;

if (process.env.NODE_ENV === 'production') {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
} else {
  transporter = null;
}

const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    index: true,
  },
  otp: {
    type: String,
    required: true,
  },
  userId: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    expires: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const OTPModel = mongoose.models.OTP || mongoose.model('OTP', otpSchema);

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const setupEtherealAccount = async () => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    const testTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
    });
    return testTransporter;
  } catch (error) {
    console.error('Error creating Ethereal account:', error);
    return {
      sendMail: (mailOptions) => {
        return Promise.resolve({ messageId: 'fake-message-id' });
      },
    };
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email' });
    }

    const otp = generateOTP();
    await OTPModel.deleteMany({ email });
    await OTPModel.create({
      email,
      otp,
      userId: user._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    if (process.env.NODE_ENV !== 'production') {
      return res.status(200).json({
        success: true,
        message: 'OTP generated successfully',
        devMode: true,
        devOtp: otp,
      });
    }

    try {
      if (!transporter) {
        transporter = await setupEtherealAccount();
      }

      const msg = {
        from: process.env.FROM_EMAIL || 'noreply@yourapplication.com',
        to: email,
        subject: 'Password Reset OTP',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h2 style="color: #031420; text-align: center;">Password Reset Request</h2>
            <p>We received a request to reset your password. Use the following OTP code to reset your password:</p>
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
              <h1 style="margin: 0; color: #B38939; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
            </div>
            <p>This code will expire in 15 minutes.</p>
            <p>If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
            <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message, please do not reply.</p>
          </div>
        `,
      };

      await transporter.sendMail(msg);
      res.status(200).json({
        success: true,
        message: 'OTP sent to your email',
      });
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      res.status(500).json({
        error: 'Failed to send OTP email. Please try again later.',
      });
    }
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const otpDoc = await OTPModel.findOne({ email });

    if (!otpDoc) {
      return res.status(400).json({ error: 'No OTP request found. Please request a new OTP.' });
    }

    if (otpDoc.otp !== otp) {
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

    // Validate new password format
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters and include uppercase, number, and special character' });
    }

    console.log('Updating password for user:', email);
    user.password = newPassword; // Let pre('save') hook handle hashing
    await user.save();

    await OTPModel.deleteOne({ _id: otpDoc._id });
    res.status(200).json({
      success: true,
      message: 'Password reset successful',
    });
  } catch (error) {
    console.error('Error in resetPassword:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.register = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { firstName, lastName, email, password, dateOfBirth } = req.body;
    console.log('Register attempt:', { firstName, lastName, email, dateOfBirth });

    // Validate inputs
    if (!firstName || !lastName || !email || !password || !dateOfBirth) {
      console.log('Missing required fields');
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.log('Invalid email format:', email);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate dateOfBirth
    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      console.log('Invalid date of birth:', dateOfBirth);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Invalid date of birth' });
    }
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    if (age < 18) {
      console.log('User is under 18:', { dateOfBirth, age });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'You must be at least 18 years old' });
    }

    // Validate password format
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      console.log('Invalid password format:', email);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, number, and special character' });
    }

    console.log('Checking for existing user');
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      console.log('Email already exists:', email);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Email already in use' });
    }

    console.log('Creating new user');
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      dateOfBirth: dob,
    });
    const savedUser = await user.save({ session });
    console.log('User saved:', { userId: savedUser._id, email: savedUser.email });

    console.log('Checking for existing wallet');
    const existingWallet = await Wallet.findOne({ userId: savedUser._id }).session(session);
    if (existingWallet) {
      console.error('Wallet already exists for user:', savedUser._id);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Wallet already exists for this user' });
    }

    console.log('Creating wallet');
    const wallet = new Wallet({
      userId: savedUser._id.toString(),
      balance: 0,
      totalDeposits: 0,
      currency: 'NGN',
      transactions: [],
    });
    const savedWallet = await wallet.save({ session });
    console.log('Wallet created:', { walletId: savedWallet._id, userId: savedWallet.userId });

    console.log('Verifying wallet existence');
    const verifyWallet = await Wallet.findOne({ userId: savedUser._id.toString() }).session(session);
    if (!verifyWallet) {
      console.error('Wallet verification failed: Wallet not found after save', { userId: savedUser._id });
      throw new Error('Wallet creation failed: Wallet not found after save');
    }
    console.log('Wallet verified:', { walletId: verifyWallet._id });

    await session.commitTransaction();
    console.log('Transaction committed for user:', { userId: savedUser._id, walletId: savedWallet._id });

    session.endSession();

    console.log('Generating JWT token');
    const token = jwt.sign({ id: savedUser._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      message: 'User and wallet registered successfully',
      token,
      user: {
        id: savedUser._id,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        email: savedUser.email,
      },
      walletId: savedWallet._id,
    });
  } catch (error) {
    console.error('Registration error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });
    await session.abortTransaction();
    session.endSession();
    if (error.code === 11000) {
      if (error.keyPattern?.email) {
        return res.status(400).json({ error: 'Email already in use', details: error.keyValue });
      }
      if (error.keyPattern?.userId) {
        return res.status(400).json({ error: 'Wallet already exists for this user', details: error.keyValue });
      }
      if (error.keyPattern?.['transactions.reference']) {
        return res.status(400).json({
          error: 'Database error: Duplicate transaction reference',
          details: error.keyValue,
          message: 'Please contact support or try again later.',
        });
      }
      return res.status(400).json({ error: 'Database error: Duplicate key', details: error.keyValue });
    }
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};


exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('Login attempt:', { email, password: '[REDACTED]' });

    if (!email || !password) {
      console.log('Missing email or password');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      console.log('User not found:', email);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('User found:', { userId: user._id, email: user.email, passwordHash: user.password });

    const isMatch = await user.comparePassword(password);
    console.log('Password comparison result:', isMatch);

    if (!isMatch) {
      console.log('Invalid password attempt for user:', email);
      return res.status(401).json({ error: 'Invalid credentials', details: 'Password mismatch' });
    }

    let wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      console.warn('Wallet not found during login, recreating:', user._id);
      wallet = new Wallet({
        userId: user._id.toString(),
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet recreated during login:', { userId: user._id, walletId: wallet._id });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    console.log('Login successful, token generated:', { userId: user._id, token: '[REDACTED]' });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
      walletId: wallet._id,
    });
  } catch (error) {
    console.error('Login error:', {
      message: error.message,
      stack: error.stack,
      email,
      body: req.body,
    });
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};