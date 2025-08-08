const User = require('../modules/Users');
const Transaction = require('../modules/Transactions');
const KYC = require('../modules/Kyc');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

exports.getDashboardStats = async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const transactionCount = await Transaction.countDocuments();
    const pendingKYC = await KYC.countDocuments({ status: 'pending' });
    const totalTransactionAmount = await Transaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        userCount,
        transactionCount,
        pendingKYC,
        totalTransactionAmount: totalTransactionAmount[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    console.log('Admin fetching all users');
    
    // Fetch all users with all needed fields except password
    const users = await User.find()
      .select('-password') // Exclude only password
      .sort({ createdAt: -1 }); // Sort by newest first
    
    console.log(`Found ${users.length} users`);
    
    if (!users || users.length === 0) {
      console.log('No users found');
      return res.status(200).json({ 
        success: true, 
        data: [] // Return empty array instead of nested object
      });
    }

    // Add avatar URLs and ensure all fields are present
    const usersWithAvatars = users.map(user => ({
      ...user.toObject(),
      avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
      // Ensure required fields have default values if missing
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || '',
      phoneNumber: user.phoneNumber || '',
      bank: user.bank || '',
      accountNumber: user.accountNumber || '',
      isAdmin: user.isAdmin || false,
      dateOfBirth: user.dateOfBirth || null,
      avatarSeed: user.avatarSeed || user._id,
      paystackCustomerCode: user.paystackCustomerCode || '',
      createdAt: user.createdAt || new Date()
    }));

    // Return users array directly in data field to match frontend expectation
    res.status(200).json({ 
      success: true, 
      data: usersWithAvatars // Return array directly, not nested in users object
    });
    
  } catch (error) {
    console.error('Error fetching users:', {
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      success: false,
      error: 'Internal Server Error', 
      details: error.message 
    });
  }
};

exports.getAllTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find();
    res.status(200).json({ success: true, data: { transactions } });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getPendingKYC = async (req, res) => {
  try {
    const pendingKYC = await KYC.find({ status: 'pending' });
    res.status(200).json({ success: true, data: { pendingKYC } });
  } catch (error) {
    console.error('Error fetching pending KYC:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.adminLogin = async (req, res) => {
  const requestId = uuidv4();
  console.time(`Admin Login Process ${requestId}`);
  try {
    const { email, password } = req.body;

    console.log(`Admin login attempt for email: ${email}`);
    console.log(`Received password: ${password}`);

    if (!email || !password) {
      console.timeEnd(`Admin Login Process ${requestId}`);
      return res.status(400).json({ error: 'Email and password are required' });
    }

    console.time(`Find Admin ${requestId}`);
    const user = await User.findOne({ email, isAdmin: true }).select('+password');
    console.timeEnd(`Find Admin ${requestId}`);
    if (!user) {
      console.timeEnd(`Admin Login Process ${requestId}`);
      return res.status(404).json({ error: 'Admin user not found' });
    }

    console.time(`Compare Password ${requestId}`);
    const isMatch = await user.comparePassword(password);
    console.timeEnd(`Compare Password ${requestId}`);
    console.log(`Password comparison result: ${isMatch}`);
    if (!isMatch) {
      console.timeEnd(`Admin Login Process ${requestId}`);
      return res.status(401).json({ error: 'Invalid credentials', details: 'Password mismatch' });
    }

    console.time(`Generate Tokens ${requestId}`);
    const accessToken = jwt.sign({ id: user._id, isAdmin: user.isAdmin }, process.env.JWT_SECRET, { expiresIn: '1h' });
    console.timeEnd(`Generate Tokens ${requestId}`);

    res.status(200).json({
      success: true,
      message: 'Admin login successful',
      accessToken,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isAdmin: user.isAdmin,
      },
    });
    console.timeEnd(`Admin Login Process ${requestId}`);
  } catch (error) {
    console.error('Admin login error:', { message: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error', details: error.message });
    console.timeEnd(`Admin Login Process ${requestId}`);
  }
};