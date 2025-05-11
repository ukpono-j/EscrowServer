const mongoose = require('mongoose');


const transactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'transfer'],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  reference: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending',
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const walletSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true, // Ensure one wallet per user
    index: true, // Single index definition
  },
  balance: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalDeposits: {
    type: Number,
    default: 0,
    min: 0,
  },
  currency: {
    type: String,
    default: 'NGN',
  },
  transactions: [transactionSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Prevent wallet deletion entirely
walletSchema.pre('deleteOne', { document: true, query: false }, async function (next) {
  throw new Error('Wallet deletion is not allowed. Wallets are permanent.');
});

// Prevent wallet deletion via query (e.g., deleteMany)
walletSchema.pre('deleteMany', async function (next) {
  throw new Error('Bulk wallet deletion is not allowed. Wallets are permanent.');
});

// Recalculate balance based on completed transactions
walletSchema.methods.recalculateBalance = async function () {
  const completedDeposits = this.transactions
    .filter((t) => t.type === 'deposit' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);

  const completedWithdrawals = this.transactions
    .filter((t) => t.type === 'withdrawal' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);

  this.balance = completedDeposits - completedWithdrawals;
  this.totalDeposits = completedDeposits;

  if (this.balance < 0) {
    throw new Error('Balance cannot be negative');
  }
};

module.exports = mongoose.model('Wallet', walletSchema);