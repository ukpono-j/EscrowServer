const mongoose = require('mongoose');
const axios = require('axios');
const Notification = require('./Notification');
const NodeCache = require('node-cache');

// Singleton cache instance
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
        console.error('User not found for wallet sync:', { userId: this.userId });
        throw new Error('User not found');
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
            throw new Error('Failed to create Paystack customer');
          }
          user.paystackCustomerCode = customerResponse.data.data.customer_code;
          await user.save({ session });
          console.log('Paystack customer created:', { userId: this.userId, customerCode: user.paystackCustomerCode });
        } catch (customerError) {
          console.error('Error creating Paystack customer:', {
            userId: this.userId,
            message: customerError.message,
            status: customerError.response?.status,
            response: customerError.response?.data,
          });
          throw customerError;
        }
      }

      try {
        const { totalDeposits, transactions: paystackTransactions } = await getPaystackCustomerBalance(user.paystackCustomerCode);
        console.log('Paystack transactions fetched:', {
          userId: this.userId,
          transactionCount: paystackTransactions.length,
          totalDeposits,
        });

        // Update local transactions
        const paystackRefs = new Set(paystackTransactions.map(t => t.reference));
        for (const tx of this.transactions) {
          if (tx.type === 'deposit' && tx.status === 'completed' && !paystackRefs.has(tx.paystackReference)) {
            console.warn(`Marking transaction ${tx.reference} as failed due to Paystack mismatch`);
            tx.status = 'failed';
            tx.metadata.error = 'Not found in Paystack';
            this.markModified('transactions');
          }
          if (tx.type === 'deposit' && tx.status === 'pending' && !tx.paystackReference) {
            console.log(`Reconciling pending transaction ${tx.reference}`);
            const matchingTx = paystackTransactions.find(pt => pt.amount === tx.amount && pt.date >= tx.createdAt);
            if (matchingTx) {
              tx.paystackReference = matchingTx.reference;
              tx.status = 'completed';
              this.markModified('transactions');
              console.log('Transaction reconciled:', { reference: tx.reference, paystackReference: matchingTx.reference });
              await Notification.create([{
                userId: this.userId,
                title: 'Transaction Reconciled',
                message: `Pending transaction ${tx.reference} reconciled with Paystack reference ${tx.paystackReference}`,
                type: 'system',
                status: 'completed',
                createdAt: new Date(),
              }], { session });
            }
          }
        }

        // Add new Paystack transactions not in local wallet
        for (const pt of paystackTransactions) {
          if (!this.transactions.some(t => t.paystackReference === pt.reference)) {
            const amountInNaira = pt.amount;
            this.transactions.push({
              type: 'deposit',
              amount: amountInNaira,
              reference: `FUND_${this.userId}_${require('uuid').v4()}`,
              paystackReference: pt.reference,
              status: 'completed',
              metadata: {
                paymentGateway: 'Paystack',
                customerEmail: user.email,
                virtualAccount: this.virtualAccount,
                reconciledManually: true,
                reconciledAt: new Date(),
              },
              createdAt: new Date(pt.date),
            });
            this.markModified('transactions');
            console.log('Added new Paystack transaction:', { reference: pt.reference, amount: amountInNaira });
          }
        }

        // Calculate balance
        const completedDeposits = this.transactions
          .filter(t => t.type === 'deposit' && t.status === 'completed')
          .reduce((sum, t) => sum + t.amount, 0);
        const completedWithdrawals = this.transactions
          .filter(t => t.type === 'withdrawal' && t.status === 'completed')
          .reduce((sum, t) => sum + t.amount, 0);

        this.balance = Math.max(0, completedDeposits - completedWithdrawals);
        this.totalDeposits = completedDeposits;
        this.lastSynced = new Date();

        console.log('Balance synced successfully:', {
          userId: this.userId,
          newBalance: this.balance,
          totalDeposits: this.totalDeposits,
          transactionCount: this.transactions.length,
        });

        await Notification.create([{
          userId: this.userId,
          title: 'Wallet Balance Synced',
          message: `Wallet balance synced with Paystack. New balance: ₦${this.balance.toFixed(2)}`,
          type: 'system',
          status: 'completed',
          createdAt: new Date(),
        }], { session });

        await this.save({ session });

        // Invalidate cache after sync using the singleton cache instance
        const cacheKey = `wallet_balance_${this.userId}`;
        cache.del(cacheKey);
        console.log('Cache invalidated after sync:', { cacheKey });
      } catch (paystackError) {
        console.error('Paystack API error during balance sync:', {
          userId: this.userId,
          message: paystackError.message,
          status: paystackError.response?.status,
          response: paystackError.response?.data,
        });
        throw paystackError;
      }
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
