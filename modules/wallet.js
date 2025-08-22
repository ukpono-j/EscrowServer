const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['deposit', 'withdrawal', 'transfer'], required: true },
  amount: { type: Number, required: true, min: 0 },
  reference: { type: String, required: true, unique: true },
  paystackReference: { type: String, unique: true, sparse: true },
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

const withdrawalRequestSchema = new mongoose.Schema({
  type: { type: String, default: 'withdrawal' },
  amount: { type: Number, required: true, min: 100 },
  reference: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' }, // Changed 'completed' to 'paid'
  metadata: {
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    bankName: { type: String, required: true },
    bankCode: { type: String, required: true },
    requestDate: { type: Date, required: true },
    expectedPayoutDate: { type: Date, required: true },
    manualProcessing: { type: Boolean, default: true },
    paidDate: { type: Date }, // Added paidDate
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
  withdrawalRequests: [withdrawalRequestSchema],
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

// Validate transactions and withdrawal requests before saving
walletSchema.pre('save', function (next) {
  const references = new Set();
  const paystackRefs = new Set();
  const withdrawalRefs = new Set();

  // Validate transactions
  if (this.isModified('transactions')) {
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
      references.add(tx.reference.toLowerCase());
      if (tx.paystackReference) paystackRefs.add(tx.paystackReference);
      tx.updatedAt = new Date();
    });
  }

  // Validate withdrawal requests
  if (this.isModified('withdrawalRequests')) {
    this.withdrawalRequests.forEach((wr, index) => {
      if (!wr.reference) {
        throw new Error(`Withdrawal request at index ${index} has invalid reference`);
      }
      if (withdrawalRefs.has(wr.reference)) {
        throw new Error(`Duplicate withdrawal request reference ${wr.reference} at index ${index}`);
      }
      if (wr.amount < 100) {
        throw new Error(`Withdrawal request at index ${index} has invalid amount. Minimum is ₦100`);
      }
      if (!/^\d{10}$/.test(wr.metadata?.accountNumber)) {
        throw new Error(`Withdrawal request at index ${index} has invalid account number`);
      }
      if (!wr.metadata?.accountName) {
        throw new Error(`Withdrawal request at index ${index} has invalid account name`);
      }
      if (!wr.metadata?.bankName) {
        throw new Error(`Withdrawal request at index ${index} has invalid bank name`);
      }
      if (!wr.metadata?.bankCode) {
        throw new Error(`Withdrawal request at index ${index} has invalid bank code`);
      }
      withdrawalRefs.add(wr.reference.toLowerCase());
      wr.updatedAt = new Date();
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
walletSchema.index({ 'withdrawalRequests.reference': 1 }, { unique: true });

module.exports = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);