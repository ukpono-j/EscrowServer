const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const axios = require('axios');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();
};

// ═══════════════════════════════════════════════════════════
// DIRECT REGISTRATION (NO OTP)
// ═══════════════════════════════════════════════════════════

const register = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { firstName, lastName, email, password, dateOfBirth, phoneNumber } = req.body;

    const sanitized = {
      firstName: sanitizeInput(firstName),
      lastName: sanitizeInput(lastName),
      email: sanitizeInput(email?.toLowerCase()),
      password,
      phoneNumber: sanitizeInput(phoneNumber),
      dateOfBirth: sanitizeInput(dateOfBirth)
    };

    // Validation
    if (!sanitized.firstName || !sanitized.lastName || !sanitized.email ||
      !sanitized.password || !sanitized.dateOfBirth || !sanitized.phoneNumber) {
      throw new Error('All fields are required');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized.email)) {
      throw new Error('Invalid email format');
    }

    if (!/^(0\d{10}|\+234\d{10})$/.test(sanitized.phoneNumber)) {
      throw new Error('Invalid Nigerian phone number');
    }

    const dob = new Date(sanitized.dateOfBirth);
    if (isNaN(dob.getTime()) || (new Date().getFullYear() - dob.getFullYear() < 18)) {
      throw new Error('Must be 18+ years old');
    }

    if (sanitized.password.length < 8 || !/[A-Z]/.test(sanitized.password) ||
      !/[0-9]/.test(sanitized.password) || !/[^A-Za-z0-9]/.test(sanitized.password)) {
      throw new Error('Password must be 8+ chars with upper, number & special char');
    }

    // Check if user already exists
    const existing = await User.findOne({ email: sanitized.email });
    if (existing) {
      throw new Error('Email already registered');
    }

    // Create new user
    const user = new User({
      firstName: sanitized.firstName,
      lastName: sanitized.lastName,
      email: sanitized.email,
      password: sanitized.password,
      dateOfBirth: dob,
      phoneNumber: sanitized.phoneNumber,
      emailVerified: true // Auto-verified since no OTP
    });

    const savedUser = await user.save({ session });

    // Create wallet
    const wallet = new Wallet({
      userId: savedUser._id.toString(),
      balance: 0,
      totalDeposits: 0,
      currency: 'NGN',
      transactions: []
    });
    const savedWallet = await wallet.save({ session });

    // Create Paystack customer (optional, non-blocking)
    try {
      const resp = await axios.post(
        'https://api.paystack.co/customer',
        {
          email: sanitized.email,
          first_name: sanitized.firstName,
          last_name: sanitized.lastName,
          phone: sanitized.phoneNumber,
          metadata: { userId: savedUser._id.toString() }
        },
        { 
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
          timeout: 10000
        }
      );

      if (resp.data?.status) {
        await User.updateOne(
          { _id: savedUser._id },
          { $set: { paystackCustomerCode: resp.data.data.customer_code } },
          { session }
        );
      }
    } catch (payErr) {
      console.warn('⚠️  Paystack customer creation failed:', payErr.message);
      // Continue registration even if Paystack fails
    }

    // Create welcome notification
    await Notification.create([{
      userId: savedUser._id,
      title: 'Welcome to Sylo!',
      message: 'Account created successfully. Start transacting securely.',
      type: 'registration',
      status: 'completed'
    }], { session });

    await session.commitTransaction();

    // Generate tokens
    const accessToken = jwt.sign({ id: savedUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: savedUser._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    return res.status(201).json({
      success: true,
      message: 'Registration completed successfully',
      accessToken,
      refreshToken,
      user: {
        id: savedUser._id,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        dateOfBirth: savedUser.dateOfBirth.toISOString().split('T')[0]
      },
      walletId: savedWallet._id
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('❌ Registration error:', err);
    return res.status(400).json({ error: err.message || 'Registration failed' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanEmail = sanitizeInput(email?.toLowerCase());

    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: cleanEmail }).select('+password');
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Ensure wallet exists
    let wallet = await Wallet.findOne({ userId: user._id.toString() });
    if (!wallet) {
      wallet = await new Wallet({ 
        userId: user._id.toString(), 
        balance: 0, 
        currency: 'NGN',
        transactions: []
      }).save();
    }

    const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    return res.status(200).json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        dateOfBirth: user.dateOfBirth?.toISOString().split('T')[0]
      },
      walletId: wallet._id
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ═══════════════════════════════════════════════════════════
// FORGOT PASSWORD (Disabled - returns message)
// ═══════════════════════════════════════════════════════════

const forgotPassword = async (req, res) => {
  return res.status(503).json({ 
    error: 'Password reset feature is temporarily disabled. Please contact support.' 
  });
};

// ═══════════════════════════════════════════════════════════
// RESET PASSWORD (Disabled - returns message)
// ═══════════════════════════════════════════════════════════

const resetPassword = async (req, res) => {
  return res.status(503).json({ 
    error: 'Password reset feature is temporarily disabled. Please contact support.' 
  });
};

// ═══════════════════════════════════════════════════════════
// REFRESH TOKEN
// ═══════════════════════════════════════════════════════════

const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newAccess = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return res.status(200).json({ accessToken: newAccess });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
};

// ═══════════════════════════════════════════════════════════
// DEPRECATED OTP METHODS (For backward compatibility)
// ═══════════════════════════════════════════════════════════

const requestRegistrationOTP = async (req, res) => {
  return res.status(503).json({ 
    error: 'OTP feature is disabled. Please use direct registration.' 
  });
};

const verifyRegistrationOTP = async (req, res) => {
  return res.status(503).json({ 
    error: 'OTP feature is disabled. Please use direct registration.' 
  });
};

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  refreshToken,
  // Legacy OTP exports (return disabled message)
  requestRegistrationOTP,
  verifyRegistrationOTP
};