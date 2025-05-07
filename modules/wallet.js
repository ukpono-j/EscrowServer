const mongoose = require('mongoose');

const WalletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
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
    uppercase: true,
  },
  transactions: [{
    type: {
      type: String,
      enum: ['deposit', 'withdrawal', 'transfer'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    reference: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
    },
    metadata: {
      type: Object,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update timestamp before saving
WalletSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Method to calculate total deposits from transactions
WalletSchema.methods.calculateTotalDeposits = function () {
  return this.transactions
    .filter((t) => t.type === 'deposit' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
};

// Method to recalculate balance from completed transactions
WalletSchema.methods.recalculateBalance = async function () {
  this.balance = this.transactions
    .filter((t) => t.type === 'deposit' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
  this.totalDeposits = this.balance;
  await this.save();
  return this.balance;
};

module.exports = mongoose.model('Wallet', WalletSchema);