const mongoose = require('mongoose');
const axios = require('axios');
const Notification = require('./Notification');

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

const getPaystackCustomerBalance = async (customerCode, retries = 3) => {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction?customer=${customerCode}&status=success&perPage=100`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        timeout: 10000,
      }
    );

    if (response.data.status && response.data.data) {
      const transactions = response.data.data;
      const totalDeposits = transactions
        .filter(t => t.status === 'success' && t.amount > 0)
        .reduce((sum, t) => sum + (t.amount / 100), 0);

      return {
        totalDeposits,
        transactions: transactions.map(t => ({
          reference: t.reference,
          amount: t.amount / 100,
          date: t.transaction_date,
        })),
      };
    }
    throw new Error('Invalid Paystack response');
  } catch (error) {
    if (retries > 0 && error.response?.status !== 401) {
      console.warn(`Retrying Paystack customer balance fetch, attempts left: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getPaystackCustomerBalance(customerCode, retries - 1);
    }
    console.error('Paystack customer balance fetch failed:', {
      customerCode,
      message: error.message,
      status: error.response?.status,
      response: error.response?.data,
    });
    throw error;
  }
};

walletSchema.methods.recalculateBalance = async function () {
  console.warn('recalculateBalance is deprecated, using syncBalanceWithPaystack instead');
  await this.syncBalanceWithPaystack();
};

walletSchema.methods.syncBalanceWithPaystack = async function () {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const User = mongoose.model('User');
      let user = await User.findById(this.userId).session(session);
      if (!user) {
        console.warn('User not found for wallet sync:', this.userId);
        this.lastSynced = new Date();
        await this.save({ session });
        return;
      }

      if (!user.paystackCustomerCode) {
        console.log(`Creating Paystack customer for user ${this.userId}`);
        try {
          const customerResponse = await axios.post(
            'https://api.paystack.co/customer',
            {
              email: user.email,
              first_name: user.firstName || 'Unknown',
              last_name: user.lastName || 'Unknown',
              phone: user.phoneNumber || '',
            },
            {
              headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
              timeout: 20000,
            }
          );
          if (!customerResponse.data.status) {
            console.error('Failed to create Paystack customer:', {
              userId: this.userId,
              message: customerResponse.data.message,
              response: customerResponse.data,
            });
            await Notification.create([{
              userId: this.userId,
              title: 'Payment Provider Error',
              message: 'Failed to sync wallet due to payment provider configuration issue. Please contact support.',
              type: 'system',
              status: 'error',
              createdAt: new Date(),
            }], { session });
            this.lastSynced = new Date();
            await this.save({ session });
            return;
          }
          user.paystackCustomerCode = customerResponse.data.data.customer_code;
          await user.save({ session });
        } catch (customerError) {
          console.error('Failed to create Paystack customer:', {
            userId: this.userId,
            message: customerError.message,
            status: customerError.response?.status,
            response: customerError.response?.data,
          });
          await Notification.create([{
            userId: this.userId,
            title: 'Payment Provider Error',
            message: `Failed to sync wallet: ${customerError.message}. Please contact support.`,
            type: 'system',
            status: 'error',
            createdAt: new Date(),
          }], { session });
          this.lastSynced = new Date();
          await this.save({ session });
          return;
        }
      }

      try {
        const { totalDeposits, transactions: paystackTransactions } = await getPaystackCustomerBalance(user.paystackCustomerCode);
        const completedWithdrawals = this.transactions
          .filter(t => t.type === 'withdrawal' && t.status === 'completed')
          .reduce((sum, t) => sum + t.amount, 0);

        const localDeposits = this.transactions
          .filter(t => t.type === 'deposit' && t.status === 'completed')
          .reduce((sum, t) => sum + t.amount, 0);

        const discrepancy = Math.abs(localDeposits - totalDeposits);
        if (discrepancy > 0.01) {
          console.warn(`Balance discrepancy detected for user ${this.userId}: Local ₦${localDeposits.toFixed(2)}, Paystack ₦${totalDeposits.toFixed(2)}`);
          const paystackRefs = new Set(paystackTransactions.map(t => t.reference));
          for (const tx of this.transactions) {
            if (tx.type === 'deposit' && tx.status === 'completed' && !paystackRefs.has(tx.paystackReference)) {
              console.warn(`Marking transaction ${tx.reference} as failed due to Paystack mismatch`);
              tx.status = 'failed';
              tx.metadata.error = 'Not found in Paystack';
              this.markModified('transactions');
            }
            // Check for pending transactions with missing paystackReference
            if (tx.type === 'deposit' && tx.status === 'pending' && !tx.paystackReference) {
              console.warn(`Pending transaction ${tx.reference} missing paystackReference, attempting to reconcile`);
              try {
                const response = await axios.get(`https://api.paystack.co/transaction?customer=${user.paystackCustomerCode}&status=success&perPage=100`, {
                  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
                  timeout: 10000,
                });
                const matchingTx = response.data.data.find(pt => pt.amount / 100 === tx.amount && pt.customer.email === user.email);
                if (matchingTx) {
                  tx.paystackReference = matchingTx.reference;
                  tx.status = 'completed';
                  this.balance += tx.amount;
                  this.totalDeposits += tx.amount;
                  this.markModified('transactions');
                  await Notification.create([{
                    userId: this.userId,
                    title: 'Transaction Reconciled',
                    message: `Pending transaction ${tx.reference} reconciled with Paystack reference ${tx.paystackReference}`,
                    type: 'system',
                    status: 'completed',
                    createdAt: new Date(),
                  }], { session });
                }
              } catch (reconcileError) {
                console.error('Failed to reconcile pending transaction:', {
                  reference: tx.reference,
                  message: reconcileError.message,
                  status: reconcileError.response?.status,
                });
              }
            }
          }

          await Notification.create([{
            userId: this.userId,
            title: 'Balance Discrepancy',
            message: `Local deposits (₦${localDeposits.toFixed(2)}) do not match Paystack (₦${totalDeposits.toFixed(2)})`,
            type: 'system',
            status: 'error',
            createdAt: new Date(),
          }], { session });
        }

        const balanceResponse = await axios.get('https://api.paystack.co/balance', {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
          timeout: 20000,
        });
        if (!balanceResponse.data.status) {
          console.error('Failed to verify Paystack balance:', {
            userId: this.userId,
            message: balanceResponse.data.message,
            response: balanceResponse.data,
          });
          await Notification.create([{
            userId: this.userId,
            title: 'Paystack Balance Check Failed',
            message: `Failed to verify Paystack balance: ${balanceResponse.data.message}`,
            type: 'system',
            status: 'error',
            createdAt: new Date(),
          }], { session });
          this.lastSynced = new Date();
          await this.save({ session });
          return;
        }

        const paystackBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100 || 0;
        const expectedBalance = totalDeposits - completedWithdrawals;
        if (paystackBalance < expectedBalance) {
          console.error('Paystack balance insufficient:', {
            userId: this.userId,
            paystackBalance: paystackBalance.toFixed(2),
            expectedBalance: expectedBalance.toFixed(2),
          });
          await Notification.create([{
            userId: this.userId,
            title: 'Paystack Balance Issue',
            message: `Paystack balance (₦${paystackBalance.toFixed(2)}) is less than expected (₦${expectedBalance.toFixed(2)})`,
            type: 'system',
            status: 'error',
            createdAt: new Date(),
          }], { session });
        }

        this.balance = Math.max(0, expectedBalance);
        this.totalDeposits = totalDeposits;
        this.lastSynced = new Date();

        await Notification.create([{
          userId: this.userId,
          title: 'Wallet Balance Synced',
          message: `Wallet balance synced with Paystack. New balance: ₦${this.balance.toFixed(2)}`,
          type: 'system',
          status: 'completed',
          createdAt: new Date(),
        }], { session });

        console.log('Balance synced successfully:', {
          userId: this.userId,
          newBalance: this.balance,
          totalDeposits: this.totalDeposits,
        });
      } catch (paystackError) {
        console.error('Paystack API error during balance sync:', {
          userId: this.userId,
          message: paystackError.message,
          status: paystackError.response?.status,
          response: paystackError.response?.data,
        });
        if (paystackError.response?.status === 401) {
          await Notification.create([{
            userId: null, // Admin notification
            title: 'Paystack API Key Error',
            message: `Failed to sync wallet for user ${this.userId} due to invalid Paystack API key. Please update PAYSTACK_LIVE_SECRET_KEY.`,
            type: 'system',
            status: 'error',
            createdAt: new Date(),
          }], { session });
        } else {
          await Notification.create([{
            userId: this.userId,
            title: 'Balance Sync Failed',
            message: `Failed to sync wallet balance: ${paystackError.message}`,
            type: 'system',
            status: 'error',
            createdAt: new Date(),
          }], { session });
        }
        this.lastSynced = new Date();
      }

      await this.save({ session });
    });
  } catch (error) {
    console.error('Balance sync error:', {
      userId: this.userId,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    await session.endSession();
  }
};

walletSchema.methods.getBalance = async function () {
  await this.syncBalanceWithPaystack();
  return { balance: this.balance, totalDeposits: this.totalDeposits, currency: this.currency, virtualAccount: this.virtualAccount };
};

walletSchema.methods.validateWithdrawal = async function (amount) {
  await this.syncBalanceWithPaystack();
  if (amount > this.balance) {
    throw new Error(`Insufficient funds: Available ₦${this.balance.toFixed(2)}, Requested ₦${amount.toFixed(2)}`);
  }
  return true;
};

walletSchema.index({ 'transactions.reference': 1 }, { sparse: true });
walletSchema.index({ 'transactions.paystackReference': 1 }, { sparse: true, unique: true });
walletSchema.index({ 'transactions.metadata.virtualAccountId': 1 }, { sparse: true });

module.exports = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);