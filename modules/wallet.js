const mongoose = require('mongoose');
const Notification = require('./Notification');

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['deposit', 'withdrawal', 'transfer'], required: true },
  amount: { type: Number, required: true, min: 0 },
  reference: { type: String, required: true, unique: true }, // Ensure unique transaction references
  paystackReference: { type: String, unique: true, sparse: true }, // Unique Paystack reference
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  metadata: {
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
    error: { type: String },
    reconciledManually: { type: Boolean, default: false },
    reconciledAt: { type: Date },
    retryAttempts: { type: Number, default: 0 },
    lastRetryAt: { type: Date },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const walletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0, min: 0 },
  totalDeposits: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'NGN' },
  transactions: [transactionSchema],
  virtualAccount: {
    account_name: { type: String },
    account_number: { type: String },
    bank_name: { type: String },
    provider: { type: String, default: 'Paystack' },
    provider_reference: { type: String },
    dedicated_reference: { type: String },
  },
  lastSynced: { type: Date, default: Date.now },
});

// Prevent wallet deletion
walletSchema.pre('deleteOne', { document: true, query: false }, async function () {
  throw new Error('Wallet deletion not allowed');
});

walletSchema.pre('deleteMany', async function () {
  throw new Error('Bulk wallet deletion not allowed');
});

// Validate transactions before saving
walletSchema.pre('save', function (next) {
  if (this.isModified('transactions')) {
    const references = new Set();
    const paystackRefs = new Set();
    this.transactions.forEach((tx, index) => {
      if (!tx.reference) {
        throw new Error(`Transaction at index ${index} has invalid reference`);
      }
      if (references.has(tx.reference)) {
        throw new Error(`Duplicate transaction reference ${tx.reference} at index ${index}`);
      }
      if (tx.paystackReference && paystackRefs.has(tx.paystackReference)) {
        throw new Error(`Duplicate Paystack reference ${tx.paystackReference} at index ${index}`);
      }
      references.add(tx.reference);
      if (tx.paystackReference) paystackRefs.add(tx.paystackReference);
      tx.updatedAt = new Date(); // Update timestamp
    });
  }
  this.lastSynced = new Date();
  next();
});

// Method to get balance
walletSchema.methods.getBalance = async function () {
  return {
    balance: this.balance,
    totalDeposits: this.totalDeposits,
    currency: this.currency,
    virtualAccount: this.virtualAccount,
    lastSynced: this.lastSynced,
  };
};

// Method to validate funding
walletSchema.methods.validateFunding = async function (amount) {
  if (amount <= 0) {
    throw new Error('Funding amount must be greater than zero');
  }
  return true;
};

// Create indexes
walletSchema.index({ userId: 1 });
walletSchema.index({ 'transactions.reference': 1 }, { unique: true });
walletSchema.index({ 'transactions.paystackReference': 1 }, { sparse: true, unique: true });
walletSchema.index({ 'transactions.metadata.virtualAccountId': 1 }, { sparse: true });

module.exports = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);
