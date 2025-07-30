const User = require('../modules/Users');
const Transaction = require('../modules/Transactions');
const KYC = require('../modules/KYC');

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
    const users = await User.find().select('-password');
    res.status(200).json({ success: true, data: { users } });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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