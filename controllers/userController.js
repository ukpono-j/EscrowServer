const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

axiosRetry(axios, {
  retries: 5,
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

exports.getUserDetails = async (req, res) => {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const { id: userId } = req.user;
      console.log('Fetching user details:', { userId, attempt: attempt + 1 });
      const user = await User.findById(userId).select('-password');
      if (!user) {
        console.log('User not found:', userId);
        return res.status(404).json({ error: 'User not found' });
      }
      const userWithAvatar = {
        ...user.toObject(),
        avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
      };
      console.log('Sending user details response:', { userId });
      return res.status(200).json({ success: true, data: { user: userWithAvatar } });
    } catch (error) {
      attempt++;
      console.error('Error in getUserDetails:', {
        userId: req.user?.id,
        message: error.message,
        stack: error.stack,
        attempt,
      });
      if (error.code === 'ECONNRESET' && attempt < maxRetries) {
        console.log(`Retrying getUserDetails (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
        continue;
      }
      return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
  }
};

exports.getAllUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    console.log('Fetching all users:', { userId });
    const users = await User.find({ _id: { $ne: userId } }).select(['email', 'firstName', '_id', 'avatarSeed']);
    if (!users || users.length === 0) {
      console.log('No other users found:', userId);
      return res.status(404).json({ error: 'No other users found' });
    }
    const usersWithAvatars = users.map(user => ({
      ...user.toObject(),
      avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
    }));
    res.status(200).json({ success: true, data: { users: usersWithAvatars } });
  } catch (error) {
    console.error('Error in getAllUserDetails:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

exports.updateUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { firstName, lastName, dateOfBirth, bank, accountNumber } = req.body;
    console.log('Updating user details:', { userId, firstName, lastName, dateOfBirth, bank, accountNumber });
    const user = await User.findById(userId);
    if (!user) {
      console.log('User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.dateOfBirth = dateOfBirth || user.dateOfBirth;
    user.bank = bank || user.bank;
    user.accountNumber = accountNumber || user.accountNumber;
    await user.save();
    const avatarIdentifier = user.avatarSeed || user._id;
    const userWithAvatar = {
      ...user.toObject(),
      avatarImage: `/api/avatar/${avatarIdentifier}`,
    };
    res.status(200).json({ success: true, data: { message: 'User details updated successfully!', user: userWithAvatar } });
  } catch (error) {
    console.error('Error in updateUserDetails:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    console.log('Forgot password attempt:', { email });

    const user = await User.findOne({ email });
    if (!user) {
      console.log('No user found for email:', email);
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
    console.log('OTP created:', { email, otp, userId: user._id });

    if (process.env.NODE_ENV !== 'production') {
      return res.status(200).json({ data: { message: 'OTP generated successfully', devMode: true, devOtp: otp } });
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
      console.log('OTP email sent:', { email });
      res.status(200).json({ data: { message: 'OTP sent to your email' } });
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      res.status(500).json({ error: 'Failed to send OTP email. Please try again later.' });
    }
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    console.log('Reset password attempt:', { email, otp, newPassword: '[REDACTED]' });

    const otpDoc = await OTPModel.findOne({ email });
    if (!otpDoc) {
      console.log('No OTP found for email:', email);
      return res.status(400).json({ error: 'No OTP request found. Please request a new OTP.' });
    }

    if (otpDoc.otp !== otp) {
      console.log('Invalid OTP for email:', email);
      return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }

    if (new Date() > new Date(otpDoc.expiresAt)) {
      await OTPModel.deleteOne({ _id: otpDoc._id });
      console.log('Expired OTP for email:', email);
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    const userId = otpDoc.userId;
    const user = await User.findById(userId);
    if (!user) {
      console.log('User not found for OTP:', { email, userId });
      return res.status(404).json({ error: 'User not found.' });
    }

    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      console.log('Invalid new password format:', email);
      return res.status(400).json({ error: 'New password must be at least 8 characters and include uppercase, number, and special character' });
    }

    console.log('Updating password for user:', email);
    user.password = newPassword; // Let pre('save') hook handle hashing
    await user.save();

    await OTPModel.deleteOne({ _id: otpDoc._id });
    console.log('Password reset successful, OTP deleted:', { email, userId });

    res.status(200).json({ data: { message: 'Password reset successful' } });
  } catch (error) {
    console.error('Error in resetPassword:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

exports.register = async (req, res) => {
  let session = null;
  let savedUser = null;
  let savedWallet = null;
  console.time('Register Process');

  try {
    // Start transaction for user and wallet creation
    session = await mongoose.startSession();
    session.startTransaction();
    console.log('Transaction started');

    const { firstName, lastName, email, password, dateOfBirth, phoneNumber } = req.body;
    console.log('Register attempt:', { firstName, lastName, email, dateOfBirth, phoneNumber, password: '[REDACTED]' });

    // Validate inputs
    if (!firstName || !lastName || !email || !password || !dateOfBirth || !phoneNumber) {
      console.log('Missing required fields');
      throw new Error('All fields are required');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.log('Invalid email format:', email);
      throw new Error('Invalid email format');
    }

    if (!/^(0\d{10}|\+234\d{10})$/.test(phoneNumber)) {
      console.log('Invalid phone number format:', phoneNumber);
      throw new Error('Phone number must be 11 digits starting with 0 or +234');
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      console.log('Invalid date of birth:', dateOfBirth);
      throw new Error('Invalid date of birth');
    }
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    if (age < 18) {
      console.log('User is under 18:', { dateOfBirth, age });
      throw new Error('You must be at least 18 years old');
    }

    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      console.log('Invalid password format:', email);
      throw new Error('Password must be at least 8 characters and include uppercase, number, and special character');
    }

    console.timeLog('Register Process', 'Before checking existing user');
    const existingUser = await User.findOne({ email }).session(session);
    if (existingUser) {
      console.log('Email already exists:', email);
      throw new Error('Email already in use');
    }

    console.timeLog('Register Process', 'Before creating user');
    const user = new User({
      firstName,
      lastName,
      email,
      password,
      dateOfBirth: dob,
      phoneNumber,
    });

    // Save user with strict validation
    try {
      savedUser = await user.save({ session });
      console.log('User saved (raw):', savedUser);
      if (!savedUser || !savedUser._id || !mongoose.Types.ObjectId.isValid(savedUser._id)) {
        console.error('User creation failed: Invalid or missing user ID', { savedUser });
        throw new Error('User creation failed: Invalid or missing user ID');
      }
      console.log('User saved successfully:', { userId: savedUser._id, email: savedUser.email });
    } catch (userError) {
      console.error('User creation error:', {
        message: userError.message,
        stack: userError.stack,
        userData: { firstName, lastName, email, dateOfBirth, phoneNumber },
      });
      throw new Error('Failed to save user: ' + userError.message);
    }

    // Verify user in database
    const verifiedUser = await User.findById(savedUser._id).session(session);
    if (!verifiedUser) {
      console.error('User not found in database after save:', { userId: savedUser._id });
      throw new Error('User not found after save');
    }
    console.log('User verified in database:', { userId: verifiedUser._id });

    console.timeLog('Register Process', 'Before checking existing wallet');
    const existingWallet = await Wallet.findOne({ userId: savedUser._id.toString() }).session(session);
    if (existingWallet) {
      console.error('Wallet already exists for user:', savedUser._id);
      throw new Error('Wallet already exists for this user');
    }

    console.timeLog('Register Process', 'Before creating wallet');
    const wallet = new Wallet({
      userId: savedUser._id.toString(),
      balance: 0,
      totalDeposits: 0,
      currency: 'NGN',
      transactions: [],
      virtualAccount: null,
    });
    try {
      savedWallet = await wallet.save({ session });
      if (!savedWallet || !savedWallet._id) {
        console.error('Wallet creation failed: No wallet ID returned', { userId: savedUser._id });
        throw new Error('Failed to save wallet');
      }
      console.log('Wallet created:', { walletId: savedWallet._id, userId: savedWallet.userId });
    } catch (walletError) {
      console.error('Wallet creation error:', {
        message: walletError.message,
        stack: walletError.stack,
        userId: savedUser._id,
      });
      throw new Error('Failed to save wallet: ' + walletError.message);
    }

    console.timeLog('Register Process', 'Before verifying wallet');
    const verifyWallet = await Wallet.findOne({ userId: savedUser._id.toString() }).session(session);
    if (!verifyWallet) {
      console.error('Wallet verification failed: Wallet not found after save', { userId: savedUser._id });
      throw new Error('Wallet creation failed: Wallet not found after save');
    }
    console.log('Wallet verified:', { walletId: verifyWallet._id });

    // Commit transaction before non-critical steps
    await session.commitTransaction();
    console.log('Transaction committed for user:', { userId: savedUser._id, walletId: savedWallet._id });

    // End session as transaction is complete
    session.endSession();
    session = null;

    // Non-critical steps: Paystack customer creation
    let customerCode;
    try {
      console.timeLog('Register Process', 'Before creating Paystack customer');
      const customerResponse = await axios.post(
        'https://api.paystack.co/customer',
        {
          email,
          first_name: firstName,
          last_name: lastName,
          phone: phoneNumber,
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
      console.log('Paystack customer created:', { userId: savedUser._id, customerCode });
    } catch (error) {
      console.error('Error creating Paystack customer:', error.response?.data || error.message);
      // Create notification for Paystack failure (non-critical, outside transaction)
      try {
        await Notification.create({
          userId: savedUser._id,
          title: 'Account Setup Failed',
          message: 'Unable to create payment profile. Please update your profile to enable funding.',
          type: 'registration',
          status: 'failed',
        });
        console.log('Notification created for Paystack failure:', { userId: savedUser._id });
      } catch (notificationError) {
        console.warn('Failed to create notification for Paystack customer error:', notificationError.message);
      }
    }

    // Non-critical steps: Create dedicated virtual account
    if (customerCode) {
      try {
        console.timeLog('Register Process', 'Before creating virtual account');
        const accountResponse = await axios.post(
          'https://api.paystack.co/dedicated_account',
          {
            customer: customerCode,
            preferred_bank: 'wema-bank',
          },
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
        await wallet.save(); // No session needed, transaction is already committed
        console.log('Virtual account created:', {
          userId: savedUser._id,
          accountNumber: wallet.virtualAccount.account_number,
        });
      } catch (error) {
        console.error('Error creating virtual account:', error.response?.data || error.message);
        // Create notification for virtual account failure (non-critical, outside transaction)
        try {
          await Notification.create({
            userId: savedUser._id,
            title: 'Account Setup Failed',
            message: 'Unable to create virtual account. Please update your profile to enable funding.',
            type: 'registration',
            status: 'failed',
          });
          console.log('Notification created for virtual account failure:', { userId: savedUser._id });
        } catch (notificationError) {
          console.warn('Failed to create notification for virtual account error:', notificationError.message);
        }
      }
    }

    // Non-critical: Create welcome notification
    console.timeLog('Register Process', 'Before creating welcome notification');
    try {
      await Notification.create({
        userId: savedUser._id,
        title: 'Welcome to the Platform',
        message: `Welcome, ${firstName}! Your account has been created successfully.`,
        type: 'registration',
        status: 'completed',
      });
      console.log('Welcome notification created:', { userId: savedUser._id });
    } catch (notificationError) {
      console.warn('Failed to create welcome notification:', notificationError.message);
    }

    // Generate JWT
    console.timeLog('Register Process', 'Before generating JWT');
    const token = jwt.sign({ id: savedUser._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    console.log('Registration successful:', { userId: savedUser._id, token: '[REDACTED]' });

    res.status(201).json({
      data: {
        message: 'User and wallet registered successfully',
        token,
        user: {
          id: savedUser._id,
          firstName: savedUser.firstName,
          lastName: savedUser.lastName,
          email: savedUser.email,
          phoneNumber: savedUser.phoneNumber,
          dateOfBirth: savedUser.dateOfBirth,
        },
        walletId: savedWallet._id,
      },
    });
    console.timeEnd('Register Process');
  } catch (error) {
    console.error('Registration error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      savedUserState: savedUser ? { _id: savedUser._id, email: savedUser.email } : 'undefined',
    });

    // Rollback transaction if session exists
    if (session) {
      try {
        await session.abortTransaction();
        console.log('Transaction aborted');
      } catch (abortError) {
        console.error('Error aborting transaction:', abortError.message);
      } finally {
        session.endSession();
        console.log('Session ended');
      }
    }

    // Handle specific errors
    if (error.code === 11000) {
      if (error.keyPattern?.email) {
        return res.status(400).json({ error: 'Email already in use', details: error.keyValue });
      }
      if (error.keyPattern?.userId) {
        return res.status(400).json({ error: 'Wallet already exists for this user', details: error.keyValue });
      }
      return res.status(400).json({ error: 'Database error: Duplicate key', details: error.keyValue });
    }

    // Handle validation errors
    if (error.message.includes('All fields are required') ||
      error.message.includes('Invalid email format') ||
      error.message.includes('Phone number must be') ||
      error.message.includes('Invalid date of birth') ||
      error.message.includes('You must be at least 18') ||
      error.message.includes('Password must be at least') ||
      error.message.includes('Email already in use') ||
      error.message.includes('Wallet already exists')) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Internal server error', details: error.message });
    console.timeEnd('Register Process');
  }
};

exports.login = async (req, res) => {
  console.time('Login Process');
  try {
    const { email, password } = req.body;
    console.log('Login attempt:', { email, password: '[REDACTED]' });

    if (!email || !password) {
      console.log('Missing email or password');
      console.timeEnd('Login Process');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    console.timeLog('Login Process', 'Before User.findOne');
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      console.log('User not found:', email);
      console.timeEnd('Login Process');
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('User found:', { userId: user._id, email: user.email, passwordHash: user.password });
    console.timeLog('Login Process', 'After User.findOne');

    const isMatch = await user.comparePassword(password);
    console.log('Password comparison result:', isMatch);

    if (!isMatch) {
      console.log('Invalid password attempt for user:', email);
      console.timeEnd('Login Process');
      return res.status(401).json({ error: 'Invalid credentials', details: 'Password mismatch' });
    }

    console.timeLog('Login Process', 'Before Wallet.findOne');
    let wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      console.warn('Wallet not found during login, recreating:', user._id);
      wallet = new Wallet({
        userId: user._id.toString(),
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
        virtualAccount: null,
      });
      await wallet.save();
      console.log('Wallet recreated during login:', { userId: user._id, walletId: wallet._id });
    }
    console.timeLog('Login Process', 'After Wallet.findOne');

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    console.log('Login successful, token generated:', { userId: user._id, token: '[REDACTED]' });

    res.status(200).json({
      data: {
        message: 'Login successful',
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          dateOfBirth: user.dateOfBirth,
        },
        walletId: wallet._id,
      },
    });
    console.timeEnd('Login Process');
  } catch (error) {
    console.error('Login error:', {
      message: error.message,
      stack: error.stack,
      email,
      body: req.body,
    });
    res.status(500).json({ error: 'Internal server error', details: error.message });
    console.timeEnd('Login Process');
  }
};

exports.getProfile = async (req, res) => {
  console.time('GetProfile Process');
  try {
    console.log('Fetching profile for user:', req.user.id);
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      console.log('User not found:', req.user.id);
      console.timeEnd('GetProfile Process');
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      data: {
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          dateOfBirth: user.dateOfBirth,
          bank: user.bank,
          accountNumber: user.accountNumber,
        },
      },
    });
    console.timeEnd('GetProfile Process');
  } catch (error) {
    console.error('Get profile error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Internal server error', details: error.message });
    console.timeEnd('GetProfile Process');
  }
};

exports.updateProfile = async (req, res) => {
  console.time('UpdateProfile Process');
  try {
    const { firstName, lastName, dateOfBirth, bank, accountNumber, phoneNumber } = req.body;
    console.log('Update profile attempt:', { userId: req.user.id, firstName, lastName, dateOfBirth, bank, accountNumber, phoneNumber });

    if (phoneNumber && !/^(0\d{10}|\+234\d{10})$/.test(phoneNumber)) {
      console.log('Invalid phone number format:', phoneNumber);
      console.timeEnd('UpdateProfile Process');
      return res.status(400).json({
        error: 'Phone number must be 11 digits starting with 0 or +234',
      });
    }

    if (dateOfBirth) {
      const dob = new Date(dateOfBirth);
      if (isNaN(dob.getTime())) {
        console.log('Invalid date of birth:', dateOfBirth);
        console.timeEnd('UpdateProfile Process');
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
        console.timeEnd('UpdateProfile Process');
        return res.status(400).json({ error: 'You must be at least 18 years old' });
      }
    }

    const updates = {};
    if (firstName) updates.firstName = firstName;
    if (lastName) updates.lastName = lastName;
    if (dateOfBirth) updates.dateOfBirth = dateOfBirth;
    if (bank) updates.bank = bank;
    if (accountNumber) updates.accountNumber = accountNumber;
    if (phoneNumber) updates.phoneNumber = phoneNumber;

    console.timeLog('UpdateProfile Process', 'Before updating user');
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      console.log('User not found:', req.user.id);
      console.timeEnd('UpdateProfile Process');
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      data: {
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          dateOfBirth: user.dateOfBirth,
          bank: user.bank,
          accountNumber: user.accountNumber,
        },
      },
    });
    console.timeEnd('UpdateProfile Process');
  } catch (error) {
    console.error('Update profile error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Internal server error', details: error.message });
    console.timeEnd('UpdateProfile Process');
  }
};