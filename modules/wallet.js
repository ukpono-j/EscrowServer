const mongoose = require('mongoose');
const axios = require('axios');
const Notification = require('./Notification');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 600 });

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['deposit', 'withdrawal', 'transfer'], required: true },
  amount: { type: Number, required: true },
  reference: { type: String, required: true },
  paystackReference: { type: String, sparse: true },
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
    bankCode: { type: String },
    accountNumber: { type: String },
    accountName: { type: String },
    transferCode: { type: String },
    error: { type: String },
    reconciledManually: { type: Boolean },
    reconciledAt: { type: Date },
    transferredToBalance: { type: Boolean, default: false },
  },
  createdAt: { type: Date, default: Date.now },
});

const walletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0, min: 0 },
  totalDeposits: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'NGN' },
  transactions: [transactionSchema],
  createdAt: { type: Date, default: Date.now },
  virtualAccount: {
    account_name: { type: String },
    account_number: { type: String },
    bank_name: { type: String },
    provider: { type: String, default: 'Paystack' },
    provider_reference: { type: String },
    dedicated_reference: { type: String },
  },
  lastSynced: { type: Date },
});

walletSchema.pre('deleteOne', { document: true, query: false }, async function () {
  throw new Error('Wallet deletion not allowed');
});

walletSchema.pre('deleteMany', async function () {
  throw new Error('Bulk wallet deletion not allowed');
});

walletSchema.pre('save', function (next) {
  if (this.isModified('transactions')) {
    const paystackRefs = new Set();
    this.transactions.forEach((tx, index) => {
      if (!tx.reference) {
        throw new Error(`Transaction at index ${index} has invalid reference`);
      }
      if (tx.paystackReference && paystackRefs.has(tx.paystackReference)) {
        throw new Error(`Duplicate Paystack reference ${tx.paystackReference} at index ${index}`);
      }
      if (tx.paystackReference) paystackRefs.add(tx.paystackReference);
    });
  }
  next();
});

walletSchema.methods.getBalance = async function () {
  return { balance: this.balance, totalDeposits: this.totalDeposits, currency: this.currency, virtualAccount: this.virtualAccount };
};

walletSchema.methods.validateWithdrawal = async function (amount) {
  if (amount > this.balance) {
    throw new Error(`Insufficient funds: Available ₦${this.balance.toFixed(2)}, Requested ₦${amount.toFixed(2)}`);
  }
  return true;
};

walletSchema.index({ 'transactions.reference': 1 }, { sparse: true });
walletSchema.index({ 'transactions.paystackReference': 1 }, { sparse: true, unique: true });
walletSchema.index({ 'transactions.metadata.virtualAccountId': 1 }, { sparse: true });

module.exports = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);