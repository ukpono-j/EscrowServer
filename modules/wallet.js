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
  paystackReference: { 
    type: String, 
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending',
  },
  metadata: {
    type: {
      paymentGateway: { type: String },
      customerEmail: { type: String },
      virtualAccount: {
        account_name: { type: String },
        account_number: { type: String },
        bank_name: { type: String },
        provider: { type: String },
        provider_reference: { type: String },
        dedicated_reference: { type: String },
      },
      virtualAccountId: { type: String },
      webhookEvent: { type: String },
      bankCode: { type: String }, // Added for withdrawals
      accountNumber: { type: String }, // Added for withdrawals
      accountName: { type: String }, // Added for withdrawals
      transferCode: { type: String }, // Added for withdrawals
      error: { type: String }, // Added for error details
      reconciledManually: { type: Boolean }, // Optional, for manual reconciliation
      reconciledAt: { type: Date }, // Optional, for manual reconciliation
    },
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
    unique: true, // Implicitly creates an index, no need for index: true
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
  virtualAccount: {
    account_name: { type: String },
    account_number: { type: String },
    bank_name: { type: String },
    provider: { type: String, default: 'Paystack' },
    provider_reference: { type: String },
    dedicated_reference: { type: String },
  },
});

walletSchema.pre('deleteOne', { document: true, query: false }, async function (next) {
  throw new Error('Wallet deletion is not allowed.');
});

walletSchema.pre('deleteMany', async function (next) {
  throw new Error('Bulk wallet deletion is not allowed.');
});

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

walletSchema.methods.recalculateBalance = async function () {
  try {
    const completedDeposits = this.transactions
      .filter((t) => t.type === 'deposit' && t.status === 'completed')
      .reduce((sum, t) => {
        console.log('Processing deposit:', {
          reference: t.transaction,
          amount: t.amount,
          status: t.status,
        });
        return sum + t.amount;
      }, 0);

    const completedWithdrawals = this.transactions
      .filter((t) => t.type === 'withdrawal' && t.status === 'completed')
      .reduce((sum, t) => {
        console.log('Processing withdrawal:', {
          reference: t.reference,
          amount: t.amount,
          status: t.status,
        });
        return sum + t.amount;
      }, 0);

    const newBalance = completedDeposits - completedWithdrawals;

    console.log('Recalculated balance:', {
      walletId: this._id,
      completedDeposits,
      completedWithdrawals,
      newBalance,
      oldBalance: this.balance,
      transactionCount: this.transactions.length,
    });

    if (newBalance < 0) {
      throw new Error('Balance cannot be negative');
    }

    this.balance = newBalance;
    this.totalDeposits = completedDeposits;
  } catch (error) {
    console.error('Error recalculating balance:', {
      walletId: this._id,
      message: error.message,
    });
    throw error;
  }
};

// Define indexes explicitly
walletSchema.index({ 'transactions.reference': 1 }, { sparse: true });
walletSchema.index({ 'transactions.paystackReference': 1 }, { sparse: true });
walletSchema.index({ 'transactions.metadata.virtualAccountId': 1 }, { sparse: true });

module.exports = mongoose.model('Wallet', walletSchema);