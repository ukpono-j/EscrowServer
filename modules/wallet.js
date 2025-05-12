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
    unique: true,
    index: true,
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

// Prevent wallet deletion
walletSchema.pre('deleteOne', { document: true, query: false }, async function (next) {
  throw new Error('Wallet deletion is not allowed. Wallets are permanent.');
});

walletSchema.pre('deleteMany', async function (next) {
  throw new Error('Bulk wallet deletion is not allowed. Wallets are permanent.');
});

// Validate transaction references
walletSchema.pre('save', function (next) {
  if (this.isModified('transactions')) {
    this.transactions.forEach((tx, index) => {
      if (!tx.reference) {
        throw new Error(`Transaction at index ${index} has an invalid or missing reference`);
      }
    });
  }
  next();
});

// Recalculate balance
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

// Optional: Add compound index for unique references within a wallet
walletSchema.index(
  { "_id": 1, "transactions.reference": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "transactions.reference": { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('Wallet', walletSchema);