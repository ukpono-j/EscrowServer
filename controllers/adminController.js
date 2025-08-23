const User = require('../modules/Users');
const Transaction = require('../modules/Transactions');
const KYC = require('../modules/Kyc');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const pino = require('pino')();
const moment = require('moment-timezone');

exports.getDashboardStats = async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const transactionCount = await Transaction.countDocuments();
    const pendingKYC = await KYC.countDocuments({ status: 'pending' });
    const totalTransactionAmount = await Transaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$paymentAmount' } } },
    ]);

    let pendingWithdrawals = 0;
    try {
      const withdrawalsResult = await Wallet.aggregate([
        { $unwind: '$withdrawalRequests' },
        { $match: { 'withdrawalRequests.status': 'pending' } },
        { $group: { _id: null, total: { $sum: '$withdrawalRequests.amount' } } },
      ]);
      pendingWithdrawals = withdrawalsResult[0]?.total || 0;
    } catch (walletError) {
      console.error('Error fetching pending withdrawals:', walletError);
    }

    res.status(200).json({
      success: true,
      data: {
        userCount,
        transactionCount,
        pendingKYC,
        totalTransactionAmount: totalTransactionAmount[0]?.total || 0,
        pendingWithdrawals,
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: error.message,
    });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    console.log('Admin fetching all users');
    const users = await User.find()
      .select('-password')
      .sort({ createdAt: -1 });

    if (!users || users.length === 0) {
      console.log('No users found');
      return res.status(200).json({ success: true, data: [] });
    }

    const usersWithAvatars = users.map(user => ({
      ...user.toObject(),
      avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
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
      createdAt: user.createdAt || new Date(),
    }));

    res.status(200).json({ success: true, data: usersWithAvatars });
  } catch (error) {
    console.error('Error fetching users:', { message: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getAllTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find();
    res.status(200).json({ success: true, data: { transactions } });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getPendingKYC = async (req, res) => {
  try {
    const pendingKYC = await KYC.find({ status: 'pending' });
    res.status(200).json({ success: true, data: { pendingKYC } });
  } catch (error) {
    console.error('Error fetching pending KYC:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getAllWithdrawals = async (req, res) => {
  try {
    console.log('Admin fetching all withdrawal requests');
    const wallets = await Wallet.find()
      .populate({
        path: 'userId',
        select: 'firstName lastName email',
        match: { _id: { $exists: true } },
      })
      .lean();

    const withdrawalRequests = await Promise.all(
      wallets.flatMap(async (wallet) => {
        if (!wallet.withdrawalRequests) {
          console.warn('Wallet skipped due to missing withdrawalRequests', {
            walletId: wallet._id,
            userId: wallet.userId ? wallet.userId._id : 'missing',
          });
          return [];
        }

        if (!wallet.userId || !wallet.userId._id) {
          console.warn('Invalid or missing userId for wallet', {
            walletId: wallet._id,
            userId: wallet.userId,
          });

          return Promise.all(
            wallet.withdrawalRequests.map(async (request) => {
              // Try to find user by matching accountName with firstName + lastName
              const [firstName, ...lastNameParts] = request.metadata.accountName.split(' ');
              const lastName = lastNameParts.join(' ');
              const user = await User.findOne({
                $or: [
                  { firstName, lastName },
                  { firstName: request.metadata.accountName }, // Fallback for single-name accounts
                ],
              }).lean();

              return {
                ...request,
                userId: user ? user._id : null,
                userName: user ? `${user.firstName} ${user.lastName}` : request.metadata.accountName,
                userEmail: user ? user.email || '' : '',
              };
            })
          );
        }

        return wallet.withdrawalRequests.map(request => ({
          ...request,
          userId: wallet.userId._id,
          userName: `${wallet.userId.firstName || 'Unknown'} ${wallet.userId.lastName || 'User'}`,
          userEmail: wallet.userId.email || '',
        }));
      })
    ).then(results => results.flat());

    const sortedRequests = withdrawalRequests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    console.log('Withdrawal requests sent:', sortedRequests);
    res.status(200).json({
      success: true,
      data: sortedRequests,
    });
  } catch (error) {
    console.error('Error fetching withdrawal requests:', { message: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.markWithdrawalAsPaid = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { id } = req.params;
      const wallet = await Wallet.findOne({ 'withdrawalRequests.reference': id }).session(session);

      if (!wallet) {
        throw new Error('Withdrawal request not found');
      }

      const withdrawal = wallet.withdrawalRequests.find(w => w.reference === id);
      if (!withdrawal) {
        throw new Error('Withdrawal request not found');
      }
      if (withdrawal.status === 'paid') {
        throw new Error('Withdrawal already marked as paid');
      }

      withdrawal.status = 'paid';
      withdrawal.metadata.paidDate = moment.tz('Africa/Lagos').toDate();
      withdrawal.updatedAt = moment.tz('Africa/Lagos').toDate();
      wallet.markModified('withdrawalRequests');
      await wallet.save({ session });

      await Notification.create(
        [
          {
            userId: wallet.userId,
            title: 'Withdrawal Request Processed',
            message: `Your withdrawal request of ₦${withdrawal.amount.toFixed(2)} to ${withdrawal.metadata.accountName} at ${withdrawal.metadata.bankName} has been processed and marked as paid.`,
            reference: withdrawal.reference,
            type: 'withdrawal',
            status: 'completed',
            createdAt: moment.tz('Africa/Lagos').toDate(),
          },
        ],
        { session }
      );

      const io = req.app.get('io');
      if (io) {
        io.to(wallet.userId.toString()).emit('withdrawalUpdate', {
          reference: withdrawal.reference,
          status: 'paid',
          paidDate: withdrawal.metadata.paidDate,
        });
      }

      res.status(200).json({
        success: true,
        message: 'Withdrawal request marked as paid',
        data: {
          reference: withdrawal.reference,
          status: withdrawal.status,
          paidDate: withdrawal.metadata.paidDate,
        },
      });
    });
  } catch (error) {
    console.error('Error marking withdrawal as paid:', { message: error.message, stack: error.stack });
    res.status(400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
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