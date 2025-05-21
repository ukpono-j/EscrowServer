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
  paystackReference: { type: String, sparse: true }, // Already included as proposed for Paystack reference mapping
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

// Add index for paystackReference to optimize webhook queries
transactionSchema.index({ paystackReference: 1 }, { sparse: true });

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
  // New field to store virtual account details (optional, for dedicated_nuban)
  virtualAccount: {
    account_name: { type: String },
    account_number: { type: String },
    bank_name: { type: String },
    provider: { type: String, default: 'Paystack' },
    provider_reference: { type: String },
    dedicated_reference: { type: String },
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

// Recalculate balance with detailed logging
walletSchema.methods.recalculateBalance = async function () {
  try {
    const completedDeposits = this.transactions
      .filter((t) => t.type === 'deposit' && t.status === 'completed')
      .reduce((sum, t) => sum + t.amount, 0);

    const completedWithdrawals = this.transactions
      .filter((t) => t.type === 'withdrawal' && t.status === 'completed')
      .reduce((sum, t) => sum + t.amount, 0);

    const newBalance = completedDeposits - completedWithdrawals;

    // Detailed logging for debugging
    console.log('Recalculated balance:', {
      walletId: this._id,
      completedDeposits,
      completedWithdrawals,
      newBalance,
      oldBalance: this.balance,
      transactionCount: this.transactions.length,
    });

    this.balance = newBalance >= 0 ? newBalance : 0;
    this.totalDeposits = completedDeposits;

    if (newBalance < 0) {
      throw new Error('Balance cannot be negative');
    }
  } catch (error) {
    console.error('Error recalculating balance:', {
      walletId: this._id,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

// Optimize queries for webhook processing
walletSchema.index(
  { "_id": 1, "transactions.reference": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "transactions.reference": { $exists: true, $ne: null } } }
);
walletSchema.index(
  { "_id": 1, "transactions.paystackReference": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "transactions.paystackReference": { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('Wallet', walletSchema);