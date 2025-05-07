const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require("../modules/Users");
const Wallet = require('../modules/wallet');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

// Create transporter for sending emails
let transporter;

// Initialize email transporter based on environment
if (process.env.NODE_ENV === 'production') {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    }
  });
} else {
  transporter = null;
}

// Create OTP Schema and Model for persistent storage
const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    index: true
  },
  otp: {
    type: String,
    required: true
  },
  userId: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    expires: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const OTPModel = mongoose.models.OTP || mongoose.model('OTP', otpSchema);

// Generate a random 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Setup an Ethereal test account for local development
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
    console.error("Error creating Ethereal account:", error);
    return {
      sendMail: (mailOptions) => {
        return Promise.resolve({ messageId: 'fake-message-id' });
      }
    };
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "No account found with this email" });
    }

    const otp = generateOTP();
    await OTPModel.deleteMany({ email });
    await OTPModel.create({
      email,
      otp,
      userId: user._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    });

    if (process.env.NODE_ENV !== 'production') {
      return res.status(200).json({
        success: true,
        message: "OTP generated successfully",
        devMode: true,
        devOtp: otp
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
        `
      };

      await transporter.sendMail(msg);
      res.status(200).json({
        success: true,
        message: "OTP sent to your email"
      });
    } catch (emailError) {
      console.error("Error sending email:", emailError);
      res.status(500).json({
        error: "Failed to send OTP email. Please try again later."
      });
    }
  } catch (error) {
    console.error("Error in forgotPassword:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const otpDoc = await OTPModel.findOne({ email });

    if (!otpDoc) {
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    if (otpDoc.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP. Please try again." });
    }

    if (new Date() > new Date(otpDoc.expiresAt)) {
      await OTPModel.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    const userId = otpDoc.userId;
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { password: hashedPassword },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found." });
    }

    await OTPModel.deleteOne({ _id: otpDoc._id });
    res.status(200).json({
      success: true,
      message: "Password reset successful"
    });
  } catch (error) {
    console.error("Error in resetPassword:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.register = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { firstName, lastName, email, password, dateOfBirth } = req.body;
    console.log('Register attempt:', { firstName, lastName, email, dateOfBirth });

    // Validate input
    if (!firstName || !lastName || !email || !password || !dateOfBirth) {
      console.log('Missing required fields');
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      console.log('Email already exists:', email);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Create new user
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      dateOfBirth: new Date(dateOfBirth)
    });

    const savedUser = await user.save({ session });
    console.log('User saved:', savedUser._id, 'Password hashed:', savedUser.password.startsWith('$2b$'));
    if (!savedUser._id) {
      throw new Error('Failed to create user: No _id generated');
    }

    // Check for existing wallet
    const existingWallet = await Wallet.findOne({ userId: savedUser._id }).session(session);
    if (existingWallet) {
      console.log('Wallet already exists for user:', savedUser._id);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Wallet already exists for this user' });
    }

    // Create wallet for the user
    const wallet = new Wallet({
      userId: savedUser._id
    });
    await wallet.save({ session });
    console.log('Wallet created for user:', savedUser._id);

    await session.commitTransaction();
    session.endSession();

    // Generate JWT token
    const token = jwt.sign(
      { id: savedUser._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: savedUser._id,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        email: savedUser.email
      }
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Registration error:', error);
    if (error.code === 11000) {
      res.status(400).json({ error: 'Duplicate key error: Email or wallet already exists', details: error.keyValue });
    } else {
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });

    // Validate input
    if (!email || !password) {
      console.log('Missing email or password');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user with password
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      console.log('User not found:', email);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('User found:', user._id, 'Stored password:', user.password);

    // Check if password is a valid bcrypt hash
    const isBcryptHash = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
    let isMatch = false;

    if (isBcryptHash) {
      // Normal bcrypt comparison
      isMatch = await user.comparePassword(password);
    } else {
      // Fallback for plain-text passwords (temporary for debugging)
      console.warn('Plain-text password detected for user:', email);
      isMatch = user.password === password;
    }

    console.log('Password match:', isMatch);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};