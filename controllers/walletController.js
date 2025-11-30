const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const Notification = require('../modules/Notification');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const pino = require('../utils/logger');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 600 });
const Bottleneck = require('bottleneck');

const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 200,
});

const CRITICAL_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Opay', code: '999992' },
  { name: 'Kuda Bank', code: '090197' },
  { name: 'Zenith Bank', code: '057' },
  { name: 'Moniepoint Microfinance Bank', code: '090405' },
  { name: 'Palmpay', code: '999991' },
  { name: 'First Bank', code: '011' },
  { name: 'GTBank', code: '058' },
  { name: 'UBA', code: '033' },
  { name: 'Fidelity Bank', code: '070' },
];

const PAYSTACK_SECRET_KEY =
  process.env.NODE_ENV === 'production'
    ? process.env.PAYSTACK_LIVE_SECRET_KEY
    : process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET_KEY) {
  console.error('Paystack secret key is not set. Check PAYSTACK_TEST_SECRET_KEY or PAYSTACK_LIVE_SECRET_KEY in .env.');
  process.exit(1);
}

exports.getPaystackSecretKey = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secretKey = isProduction
    ? process.env.PAYSTACK_LIVE_SECRET_KEY
    : process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    console.error(`PAYSTACK_${isProduction ? 'LIVE_' : ''}SECRET_KEY is not set in environment variables`, {
      nodeEnv: process.env.NODE_ENV,
      isProduction,
    });
    throw new Error(`PAYSTACK_${isProduction ? 'LIVE_' : ''}SECRET_KEY not configured`);
  }

  console.log(`Using Paystack ${isProduction ? 'live' : 'test'} secret key`, { keyLength: secretKey.length });
  return secretKey;
};

const FALLBACK_BANKS = [
  'wema-bank',
  'zenith-bank',
  'uba',
  'access-bank',
];

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    console.log(`Retry attempt ${retryCount} for Paystack API at ${new Date().toISOString()}`);
    return retryCount * 2000;
  },
  retryCondition: (error) => {
    const isRetryable =
      error.code === 'ECONNABORTED' ||
      error.code === 'ERR_NETWORK' ||
      (error.response && error.response.status >= 500) ||
      (error.response && error.response.status === 429);
    console.log('Retry condition check:', {
      code: error.code,
      status: error.response?.status,
      isRetryable,
    });
    return isRetryable;
  },
});

const serializeWalletData = (wallet) => {
  if (!wallet) {
    return {
      userId: null,
      balance: 0,
      totalDeposits: 0,
      currency: 'NGN',
      transactions: [],
      lastSynced: new Date().toISOString(),
      virtualAccount: null,
    };
  }

  const walletObj = wallet.toObject ? wallet.toObject({ getters: true, virtuals: false }) : wallet;

  return {
    userId: walletObj.userId ? walletObj.userId.toString() : null,
    balance: walletObj.balance || 0,
    totalDeposits: walletObj.totalDeposits || 0,
    currency: walletObj.currency || 'NGN',
    transactions: (walletObj.transactions || []).map(tx => ({
      type: tx.type || 'unknown',
      amount: tx.amount || 0,
      status: tx.status || 'pending',
      reference: tx.reference || '',
      paystackReference: tx.paystackReference || '',
      createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : new Date(tx.createdAt).toISOString(),
      metadata: {
        ...tx.metadata,
        reconciledAt: tx.metadata?.reconciledAt instanceof Date
          ? tx.metadata.reconciledAt.toISOString()
          : tx.metadata?.reconciledAt || null,
        virtualAccount: tx.metadata?.virtualAccount
          ? {
            account_name: tx.metadata.virtualAccount.account_name,
            account_number: tx.metadata.virtualAccount.account_number,
            bank_name: tx.metadata.virtualAccount.bank_name,
            provider: tx.metadata.virtualAccount.provider,
            provider_reference: tx.metadata.virtualAccount.provider_reference,
            created_at: tx.metadata.virtualAccount.created_at instanceof Date
              ? tx.metadata.virtualAccount.created_at.toISOString()
              : tx.metadata.virtualAccount.created_at,
            active: tx.metadata.virtualAccount.active,
          }
          : null,
      },
    })),
    lastSynced: walletObj.lastSynced instanceof Date
      ? walletObj.lastSynced.toISOString()
      : new Date(walletObj.lastSynced).toISOString(),
    virtualAccount: walletObj.virtualAccount
      ? {
        account_name: walletObj.virtualAccount.account_name,
        account_number: walletObj.virtualAccount.account_number,
        bank_name: walletObj.virtualAccount.bank_name,
        provider: walletObj.virtualAccount.provider,
        provider_reference: walletObj.virtualAccount.provider_reference,
        created_at: walletObj.virtualAccount.created_at instanceof Date
          ? walletObj.virtualAccount.created_at.toISOString()
          : walletObj.virtualAccount.created_at,
        active: walletObj.virtualAccount.active,
      }
      : null,
  };
};

const serializeUserData = (user) => {
  if (!user) {
    return {
      _id: null,
      firstName: '',
      lastName: '',
      email: '',
      phoneNumber: '',
      paystackCustomerCode: null,
    };
  }

  const userObj = user.toObject ? user.toObject({ getters: true, virtuals: false }) : user;

  return {
    _id: userObj._id ? userObj._id.toString() : null,
    firstName: userObj.firstName || '',
    lastName: userObj.lastName || '',
    email: userObj.email || '',
    phoneNumber: userObj.phoneNumber || '',
    paystackCustomerCode: userObj.paystackCustomerCode || null,
  };
};

exports.checkFundingReadiness = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { id: userId } = req.user;
      const isTestMode = process.env.NODE_ENV !== 'production';

      const user = await User.findById(userId).session(session);
      if (!user) {
        logger.warn('User not found', { userId });
        throw new Error('User not found');
      }

      if (!process.env.BYPASS_PAYSTACK_BALANCE_CHECK) {
        const balanceResponse = await axios.get('https://api.paystack.co/balance', {
          headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
          timeout: 15000,
        });

        if (!balanceResponse.data?.status) {
          logger.error('Paystack API key invalid', {
            userId,
            response: balanceResponse.data,
            error: balanceResponse.data.message,
          });
          throw new Error('Payment provider configuration issue');
        }
      }

      let customerCode = user.paystackCustomerCode;
      let isValidCustomer = false;

      if (customerCode) {
        try {
          const customerValidation = await axios.get(
            `https://api.paystack.co/customer/${customerCode}`,
            {
              headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
              timeout: 15000,
            }
          );
          if (customerValidation.data.status) {
            isValidCustomer = true;
          } else {
            logger.warn('Invalid Paystack customer code', {
              userId,
              customerCode,
              response: customerValidation.data,
            });
          }
        } catch (error) {
          logger.warn('Failed to validate Paystack customer', {
            userId,
            customerCode,
            error: error.response?.data?.message || error.message,
            status: error.response?.status,
          });
        }
      }

      if (!customerCode || !isValidCustomer) {
        const customerResponse = await axios.post(
          'https://api.paystack.co/customer',
          {
            email: user.email,
            first_name: user.firstName || 'Unknown',
            last_name: user.lastName || 'Unknown',
            phone: user.phoneNumber || '',
          },
          {
            headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
            timeout: 15000,
          }
        );

        if (!customerResponse.data.status) {
          logger.error('Failed to create Paystack customer', {
            userId,
            email: user.email,
            response: customerResponse.data,
            error: customerResponse.data.message,
          });
          throw new Error('Failed to initialize payment profile');
        }

        customerCode = customerResponse.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await user.save({ session });
        logger.info('Paystack customer created', { userId, customerCode });
      }

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        wallet = new Wallet({
          userId,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
          virtualAccount: null,
        });
        await wallet.save({ session });
        logger.info('Wallet created for user', { userId, walletId: wallet._id });
      }

      if (!wallet.virtualAccount?.account_number || (process.env.NODE_ENV === 'production' && wallet.virtualAccount.account_number.startsWith('TEST'))) {
        let accountResponse = null;
        let lastError = null;

        if (isTestMode && process.env.ENABLE_MOCK_VERIFICATION) {
          logger.info('Using mock virtual account for test mode', { userId });
          wallet.virtualAccount = {
            account_name: `${user.firstName} ${user.lastName}`.trim() || 'Test User',
            account_number: `TEST${Math.floor(1000000000 + Math.random() * 9000000000)}`,
            bank_name: 'Mock Bank',
            provider: 'Paystack',
            provider_reference: `MOCK_${crypto.randomBytes(8).toString('hex')}`,
            created_at: new Date(),
            active: true,
          };
          await wallet.save({ session });
        } else {
          const banksToTry = isTestMode ? FALLBACK_BANKS : CRITICAL_BANKS.map(bank => bank.name.toLowerCase().replace(' ', '-'));
          for (const bank of banksToTry) {
            try {
              accountResponse = await axios.post(
                'https://api.paystack.co/dedicated_account',
                {
                  customer: customerCode,
                  preferred_bank: bank,
                },
                {
                  headers: {
                    Authorization: `Bearer ${exports.getPaystackSecretKey()}`,
                    'Content-Type': 'application/json',
                  },
                  timeout: 15000,
                }
              );
              if (accountResponse.data.status) {
                logger.info('Virtual account created', {
                  userId,
                  bank,
                  accountNumber: accountResponse.data.data.account_number,
                });
                break;
              }
            } catch (error) {
              lastError = error;
              logger.warn(`Failed to create virtual account with ${bank}`, {
                userId,
                customerCode,
                error: error.response?.data?.message || error.message,
                status: error.response?.status,
                response: error.response?.data,
              });
            }
          }

          if (!accountResponse?.data?.status) {
            logger.error('Failed to create virtual account with all banks', {
              userId,
              customerCode,
              lastError: lastError?.response?.data?.message || lastError?.message,
            });
            await Notification.create(
              [{
                userId,
                title: 'Funding Setup Failed',
                message: isTestMode
                  ? 'Virtual account creation is not supported in test mode. Please use live mode or contact support.'
                  : 'Unable to create virtual account. Please contact support.',
                type: 'funding',
                status: 'error',
                reference: null,
                createdAt: new Date(),
              }],
              { session }
            );
            throw new Error('Unable to create virtual account');
          }

          wallet.virtualAccount = {
            account_name: accountResponse.data.data.account_name,
            account_number: accountResponse.data.data.account_number,
            bank_name: accountResponse.data.data.bank.name,
            provider: 'Paystack',
            provider_reference: accountResponse.data.data.id,
            created_at: new Date(),
            active: true,
          };
          await wallet.save({ session });
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Funding system is ready',
        data: {
          customerCode: user.paystackCustomerCode,
          virtualAccount: wallet.virtualAccount,
          pendingTransactions: wallet.transactions.filter(t => t.status === 'pending'),
        },
      });
    });
  } catch (error) {
    logger.error('Funding readiness check error', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
    });
    return res.status(error.message === 'Unable to create virtual account' ? 400 : 500).json({
      success: false,
      error: error.message || 'Failed to check funding readiness',
    });
  } finally {
    session.endSession();
  }
};

exports.verifyFunding = async (req, res) => {
  return limiter.schedule(async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const { event, data } = req.body;
        if (!['dedicatedaccount.credit', 'charge.success', 'balance.warning', 'balance.critical'].includes(event)) {
          logger.info('Ignoring non-relevant Paystack event', { event });
          return res.status(200).json({ status: 'success' });
        }

        if (['balance.warning', 'balance.critical'].includes(event)) {
          const balance = data?.balance ? parseFloat(data.balance) / 100 : 0;
          await Notification.create(
            [{
              userId: null,
              title: event === 'balance.warning' ? 'Low Balance Warning' : 'Critical Balance Alert',
              message: `Paystack balance is ₦${balance.toFixed(2)}. Please top up to ensure smooth operations.`,
              type: 'system',
              status: 'warning',
              reference: null,
              createdAt: new Date(),
            }],
            { session }
          );
          logger.info('Balance alert processed', { event, balance });
          return res.status(200).json({ status: 'success' });
        }

        const { reference, amount, status, customer, account_details } = data;
        if (!reference || !amount || !status || !customer?.email) {
          logger.error('Invalid webhook payload', { event, data });
          throw new Error('Invalid webhook payload');
        }

        logger.info('Processing webhook event', {
          event,
          reference,
          amount,
          customerEmail: customer.email,
        });

        const user = await User.findOne({ email: customer.email }).session(session);
        if (!user) {
          logger.error('User not found for email', { email: customer.email });
          throw new Error(`User not found for email: ${customer.email}`);
        }

        let wallet = await Wallet.findOne({ userId: user._id }).session(session);
        if (!wallet) {
          wallet = new Wallet({
            userId: user._id,
            balance: 0,
            totalDeposits: 0,
            currency: 'NGN',
            transactions: [],
            lastSynced: new Date(),
          });
          await wallet.save({ session });
        }

        const existingTransaction = wallet.transactions.find(
          (t) => t.paystackReference === reference && t.status === 'completed'
        );
        if (existingTransaction) {
          logger.info('Transaction already processed', { reference });
          return res.status(200).json({ status: 'success' });
        }

        const amountInNaira = parseFloat(amount) / 100;
        if (isNaN(amountInNaira) || amountInNaira <= 0) {
          logger.error('Invalid amount in webhook', { reference, amount });
          throw new Error('Invalid amount received from Paystack');
        }

        const paystackResponse = await axios.get(
          `https://api.paystack.co/transaction/verify/${reference}`,
          {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
            timeout: 10000,
          }
        );
        if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
          logger.error('Paystack verification failed', { reference, response: paystackResponse.data });
          throw new Error('Transaction verification failed');
        }
        const verifiedAmount = parseFloat(paystackResponse.data.data.amount) / 100;
        if (verifiedAmount !== amountInNaira) {
          logger.warn('Amount mismatch in webhook', {
            webhookAmount: amountInNaira,
            verifiedAmount,
            reference,
          });
        }

        let transaction = wallet.transactions.find(
          (t) =>
            t.paystackReference === reference ||
            (t.metadata?.virtualAccountId === account_details?.id && t.status === 'pending') ||
            (t.amount === verifiedAmount && t.status === 'pending' && !t.paystackReference)
        );

        if (!transaction) {
          transaction = {
            type: 'deposit',
            amount: verifiedAmount,
            reference: `FUND_${wallet.userId}_${uuidv4()}`,
            paystackReference: reference,
            status: 'pending',
            metadata: {
              paymentGateway: 'Paystack',
              customerEmail: customer.email,
              virtualAccount: wallet.virtualAccount,
              virtualAccountId: account_details?.id,
              webhookEvent: event,
            },
            createdAt: new Date(),
          };
          wallet.transactions.push(transaction);
        } else if (!transaction.paystackReference) {
          transaction.paystackReference = reference;
          transaction.amount = verifiedAmount;
        }

        if (status === 'success') {
          transaction.status = 'completed';
          wallet.balance += verifiedAmount;
          wallet.totalDeposits += verifiedAmount;
          logger.info('Wallet funded successfully', {
            amount: verifiedAmount,
            reference,
            newBalance: wallet.balance,
            rawAmount: amount,
          });
        } else {
          transaction.status = 'failed';
          transaction.metadata.error = 'Transaction failed at Paystack';
          logger.info('Transaction failed', { reference, status });
        }

        wallet.markModified('transactions');
        await wallet.save({ session });

        const cacheKey = `wallet_balance_${wallet.userId}`;
        cache.del(cacheKey);
        logger.info('Cache cleared for wallet', { cacheKey });

        const io = req.app.get('io');
        if (io) {
          io.to(wallet.userId.toString()).emit('balanceUpdate', {
            balance: wallet.balance,
            totalDeposits: wallet.totalDeposits,
            transaction: {
              amount: verifiedAmount,
              reference: transaction.reference,
              status: transaction.status,
              type: transaction.type,
              createdAt: transaction.createdAt,
              paystackReference: transaction.paystackReference,
            },
          });
          logger.info('Balance update emitted', {
            userId: wallet.userId,
            balance: wallet.balance,
            reference: transaction.reference,
          });
        }

        if (transaction.status !== 'pending') {
          await Notification.create(
            [{
              userId: wallet.userId,
              title: transaction.status === 'completed' ? 'Wallet Funded' : 'Funding Failed',
              message:
                transaction.status === 'completed'
                  ? `Wallet funded with ₦${verifiedAmount.toFixed(2)}. Ref: ${transaction.reference}`
                  : `Funding of ₦${verifiedAmount.toFixed(2)} failed. Ref: ${transaction.reference}`,
              reference: transaction.reference,
              type: 'funding',
              status: transaction.status,
              createdAt: new Date(),
            }],
            { session }
          );
        }

        return res.status(200).json({ status: 'success' });
      });
    } catch (error) {
      logger.error('Webhook error', {
        event: req.body.event,
        reference: req.body.data?.reference,
        message: error.message,
      });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      await session.endSession();
    }
  });
};

// exports.getWalletBalance = async (req, res) => {
//   const session = await mongoose.startSession();
//   try {
//     await session.withTransaction(async () => {
//       logger.info('Fetching wallet balance for user', { userId: req.user.id });

//       let wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
//       if (!wallet) {
//         logger.warn('Wallet not found for user, creating new wallet', { userId: req.user.id });
//         const user = await User.findById(req.user.id).session(session);
//         if (!user) {
//           logger.error('User not found during wallet creation', { userId: req.user.id });
//           return res.status(404).json({ success: false, error: 'User not found' });
//         }

//         wallet = new Wallet({
//           userId: req.user.id,
//           balance: 0,
//           totalDeposits: 0,
//           currency: 'NGN',
//           transactions: [],
//           lastSynced: new Date(),
//         });
//         await wallet.save({ session });
//         logger.info('Wallet created', { userId: req.user.id, walletId: wallet._id });
//       }

//       const balanceDetails = wallet.getBalanceDetails();

//       const response = {
//         success: true,
//         data: {
//           wallet: {
//             balance: parseFloat(wallet.balance) || 0,
//             availableBalance: parseFloat(balanceDetails.availableBalance) || 0,
//             pendingWithdrawals: parseFloat(balanceDetails.pendingWithdrawals) || 0,
//             totalDeposits: parseFloat(wallet.totalDeposits) || 0,
//             transactions: Array.isArray(wallet.transactions)
//               ? wallet.transactions
//                   .map(tx => ({
//                     _id: tx._id,
//                     type: tx.type || 'unknown',
//                     amount: parseFloat(tx.amount) || 0,
//                     status: tx.status || 'pending',
//                     reference: tx.reference || '',
//                     paystackReference: tx.paystackReference || '',
//                     createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : new Date(tx.createdAt || Date.now()).toISOString(),
//                     metadata: tx.metadata || {},
//                   }))
//                   .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
//               : [],
//           },
//         },
//       };

//       res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
//       res.setHeader('Pragma', 'no-cache');
//       res.setHeader('Expires', '0');
//       res.setHeader('Surrogate-Control', 'no-store');

//       logger.info('Wallet balance retrieved', {
//         userId: req.user.id,
//         balance: response.data.wallet.balance,
//         availableBalance: response.data.wallet.availableBalance,
//         transactionCount: response.data.wallet.transactions.length,
//       });

//       res.status(200).json(response);
//     });
//   } catch (error) {
//     logger.error('Get wallet balance error', {
//       userId: req.user.id,
//       message: error.message,
//       stack: error.stack,
//     });
//     res.status(500).json({ success: false, error: 'Failed to fetch wallet balance' });
//   } finally {
//     await session.endSession();
//   }
// };


// ============================================================================
// 1. WALLET CONTROLLER FIX - Ensure getWalletBalance returns availableBalance
// ============================================================================

exports.getWalletBalance = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      logger.info('Fetching wallet balance for user', { userId: req.user.id });

      let wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        logger.warn('Wallet not found for user, creating new wallet', { userId: req.user.id });
        const user = await User.findById(req.user.id).session(session);
        if (!user) {
          logger.error('User not found during wallet creation', { userId: req.user.id });
          return res.status(404).json({ success: false, error: 'User not found' });
        }

        wallet = new Wallet({
          userId: req.user.id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
        });
        await wallet.save({ session });
        logger.info('Wallet created', { userId: req.user.id, walletId: wallet._id });
      }

      // ✅ CRITICAL: Calculate balance details
      const balanceDetails = wallet.getBalanceDetails();

      const response = {
        success: true,
        data: {
          wallet: {
            balance: parseFloat(wallet.balance) || 0,
            // ✅ ADDED: Available balance
            availableBalance: parseFloat(balanceDetails.availableBalance) || 0,
            // ✅ ADDED: Pending withdrawals amount
            pendingWithdrawals: parseFloat(balanceDetails.pendingWithdrawals) || 0,
            totalDeposits: parseFloat(wallet.totalDeposits) || 0,
            transactions: Array.isArray(wallet.transactions)
              ? wallet.transactions
                .map(tx => ({
                  _id: tx._id,
                  type: tx.type || 'unknown',
                  amount: parseFloat(tx.amount) || 0,
                  status: tx.status || 'pending',
                  reference: tx.reference || '',
                  paystackReference: tx.paystackReference || '',
                  createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : new Date(tx.createdAt || Date.now()).toISOString(),
                  metadata: tx.metadata || {},
                }))
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
              : [],
          },
        },
      };

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');

      logger.info('Wallet balance retrieved', {
        userId: req.user.id,
        balance: response.data.wallet.balance,
        availableBalance: response.data.wallet.availableBalance,
        pendingWithdrawals: response.data.wallet.pendingWithdrawals,
        transactionCount: response.data.wallet.transactions.length,
      });

      res.status(200).json(response);
    });
  } catch (error) {
    logger.error('Get wallet balance error', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ success: false, error: 'Failed to fetch wallet balance' });
  } finally {
    await session.endSession();
  }
};



exports.initiateFunding = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, email, phoneNumber, userId } = req.body;
      const amountNum = parseFloat(amount);
      const isTestMode = process.env.NODE_ENV !== 'production';

      if (!amountNum || amountNum < 100) {
        throw new Error('Invalid or missing amount. Minimum is ₦100.');
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Invalid or missing email');
      }
      if (!phoneNumber || !/^(0\d{10}|\+234\d{10})$/.test(phoneNumber)) {
        throw new Error('Invalid or missing phone number');
      }

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        wallet = new Wallet({
          userId,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
          virtualAccount: null,
        });
        await wallet.save({ session });
        logger.info('Wallet created for user', { userId, walletId: wallet._id });
      }

      const user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error('User not found');
      }

      let customerCode = user.paystackCustomerCode;
      let isValidCustomer = false;

      if (customerCode) {
        try {
          const customerValidation = await axios.get(
            `https://api.paystack.co/customer/${customerCode}`,
            {
              headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
              timeout: 15000,
            }
          );
          if (customerValidation.data.status) {
            isValidCustomer = true;
          } else {
            logger.warn('Invalid Paystack customer code', {
              userId,
              customerCode,
              response: customerValidation.data,
            });
          }
        } catch (error) {
          logger.warn('Failed to validate Paystack customer', {
            userId,
            customerCode,
            error: error.response?.data?.message || error.message,
            status: error.response?.status,
          });
        }
      }

      if (!customerCode || !isValidCustomer) {
        const customerResponse = await axios.post(
          'https://api.paystack.co/customer',
          {
            email,
            first_name: user.firstName || 'Unknown',
            last_name: user.lastName || 'Unknown',
            phone: phoneNumber,
          },
          {
            headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
            timeout: 15000,
          }
        );

        if (!customerResponse.data.status) {
          logger.error('Failed to create Paystack customer', {
            userId,
            response: customerResponse.data,
            error: customerResponse.data.message,
          });
          throw new Error('Failed to create Paystack customer');
        }

        customerCode = customerResponse.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await user.save({ session });
        logger.info('Paystack customer created', { userId, customerCode });
      }

      let virtualAccount = wallet.virtualAccount;
      if (!virtualAccount?.account_number || (process.env.NODE_ENV === 'production' && virtualAccount.account_number.startsWith('TEST'))) {
        let accountResponse = null;
        let lastError = null;

        if (isTestMode && process.env.ENABLE_MOCK_VERIFICATION) {
          logger.info('Using mock virtual account for test mode', { userId });
          virtualAccount = {
            account_name: `${user.firstName} ${user.lastName}`.trim() || 'Test User',
            account_number: `TEST${Math.floor(1000000000 + Math.random() * 9000000000)}`,
            bank_name: 'Mock Bank',
            provider: 'Paystack',
            provider_reference: `MOCK_${crypto.randomBytes(8).toString('hex')}`,
            created_at: new Date(),
            active: true,
          };
          wallet.virtualAccount = virtualAccount;
          await wallet.save({ session });
        } else {
          const banksToTry = isTestMode ? FALLBACK_BANKS : CRITICAL_BANKS.map(bank => bank.name.toLowerCase().replace(' ', '-'));
          for (const bank of banksToTry) {
            try {
              accountResponse = await axios.post(
                'https://api.paystack.co/dedicated_account',
                {
                  customer: customerCode,
                  preferred_bank: bank,
                },
                {
                  headers: {
                    Authorization: `Bearer ${exports.getPaystackSecretKey()}`,
                    'Content-Type': 'application/json',
                  },
                  timeout: 15000,
                }
              );
              if (accountResponse.data.status) {
                logger.info('Virtual account created', { userId, bank, accountNumber: accountResponse.data.data.account_number });
                break;
              }
            } catch (error) {
              lastError = error;
              logger.warn(`Failed to create virtual account with ${bank}`, {
                userId,
                customerCode,
                error: error.response?.data?.message || error.message,
                status: error.response?.status,
                response: error.response?.data,
              });
            }
          }

          if (!accountResponse?.data?.status) {
            logger.error('Failed to create virtual account with all banks', {
              userId,
              customerCode,
              lastError: lastError?.response?.data?.message || lastError?.message,
            });
            await Notification.create(
              [{
                userId,
                title: 'Funding Setup Failed',
                message: isTestMode
                  ? 'Virtual account creation is not supported in test mode. Please use live mode or contact support.'
                  : 'Unable to create virtual account. Please contact support.',
                type: 'funding',
                status: 'error',
                reference: null,
                createdAt: new Date(),
              }],
              { session }
            );
            throw new Error('Unable to create virtual account');
          }

          virtualAccount = {
            account_name: accountResponse.data.data.account_name,
            account_number: accountResponse.data.data.account_number,
            bank_name: accountResponse.data.data.bank.name,
            provider: 'Paystack',
            provider_reference: accountResponse.data.data.id,
            created_at: new Date(),
            active: true,
          };
          wallet.virtualAccount = virtualAccount;
          await wallet.save({ session });
        }
      }

      const reference = `FUND_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const transaction = {
        type: 'deposit',
        amount: amountNum,
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'Paystack',
          customerEmail: email,
          customerPhone: phoneNumber,
          virtualAccount: {
            account_name: virtualAccount.account_name,
            account_number: virtualAccount.account_number,
            bank_name: virtualAccount.bank_name,
            provider: virtualAccount.provider,
            provider_reference: virtualAccount.provider_reference,
            created_at: virtualAccount.created_at,
            active: virtualAccount.active,
          },
          virtualAccountId: virtualAccount.provider_reference,
          customerCode,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);
      await wallet.save({ session });

      await Notification.create(
        [{
          userId,
          title: 'Funding Initiated',
          message: `Funding request of ₦${amountNum.toFixed(2)} initiated.`,
          reference,
          type: 'funding',
          status: 'pending',
          createdAt: new Date(),
        }],
        { session }
      );

      const serializedWallet = serializeWalletData(wallet);

      res.status(200).json({
        success: true,
        message: 'Virtual account ready for funding',
        data: {
          virtualAccount: {
            account_name: virtualAccount.account_name,
            account_number: virtualAccount.account_number,
            bank_name: virtualAccount.bank_name,
            provider: virtualAccount.provider,
            provider_reference: virtualAccount.provider_reference,
            created_at: virtualAccount.created_at,
            active: virtualAccount.active,
          },
          reference,
          amount: amountNum,
          customerCode,
          pendingTransactions: serializedWallet.transactions
            .filter(t => t.status === 'pending')
            .map(tx => ({
              type: tx.type,
              amount: tx.amount,
              reference: tx.reference,
              status: tx.status,
              createdAt: tx.createdAt,
              metadata: {
                ...tx.metadata,
                virtualAccount: tx.metadata.virtualAccount
                  ? {
                    account_name: tx.metadata.virtualAccount.account_name,
                    account_number: tx.metadata.virtualAccount.account_number,
                    bank_name: tx.metadata.virtualAccount.bank_name,
                    provider: tx.metadata.virtualAccount.provider,
                    provider_reference: tx.metadata.virtualAccount.provider_reference,
                    created_at: tx.metadata.virtualAccount.created_at,
                    active: tx.metadata.virtualAccount.active,
                  }
                  : undefined,
              },
            })),
          instructions: {
            step1: `Transfer ₦${amountNum.toFixed(2)} to the account details below`,
            step2: isTestMode
              ? 'In test mode, use Paystack’s test bank details to simulate a transfer.'
              : 'Your wallet will be credited automatically within 5 minutes.',
            step3: 'You will receive a notification once payment is confirmed.',
          },
        },
      });
    });
  } catch (error) {
    logger.error('Funding error', {
      userId: req.body.userId,
      message: error.message,
      stack: error.stack,
    });
    res.status(error.message === 'Unable to create virtual account' ? 400 : 500).json({
      success: false,
      error: error.message || 'Failed to initiate funding',
    });
  } finally {
    await session.endSession();
  }
};

exports.retryPendingTransactions = async () => {
  try {
    const wallets = await Wallet.find({ 'transactions.status': 'pending' });
    console.log(`Found ${wallets.length} wallets with pending transactions`);
    for (const wallet of wallets) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          for (const transaction of wallet.transactions.filter(t => t.status === 'pending')) {
            try {
              if (transaction.type === 'deposit' && transaction.paystackReference) {
                const response = await axios.get(
                  `https://api.paystack.co/transaction/verify/${transaction.paystackReference}`,
                  {
                    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                    timeout: 10000,
                  }
                );

                if (response.data.status && response.data.data?.status === 'success') {
                  const amountInNaira = parseFloat(response.data.data.amount) / 100;
                  transaction.status = 'completed';
                  wallet.balance += amountInNaira;
                  wallet.totalDeposits += amountInNaira;
                  transaction.metadata.reconciledAt = new Date();
                  console.log('Deposit completed after retry:', { reference: transaction.reference, amount: amountInNaira });

                  await Notification.create([{
                    userId: wallet.userId,
                    title: 'Wallet Funded',
                    message: `Wallet funded with ₦${amountInNaira.toFixed(2)} after retry. Ref: ${transaction.reference}`,
                    reference: transaction.reference,
                    type: 'funding',
                    status: 'completed',
                    createdAt: new Date(),
                  }], { session });
                } else {
                  transaction.metadata.retryAttempts = (transaction.metadata.retryAttempts || 0) + 1;
                  console.log(`Retry attempt ${transaction.metadata.retryAttempts} for transaction ${transaction.reference}`);
                  if (transaction.metadata.retryAttempts >= 3) {
                    transaction.status = 'failed';
                    transaction.metadata.transferError = 'Max retry attempts reached';
                    await Notification.create([{
                      userId: wallet.userId,
                      title: 'Funding Failed',
                      message: `Funding of ₦${transaction.amount.toFixed(2)} failed after retries. Ref: ${transaction.reference}`,
                      reference: transaction.reference,
                      type: 'funding',
                      status: 'failed',
                      createdAt: new Date(),
                    }], { session });
                  }
                }
              }
            } catch (error) {
              console.error('Retry failed for transaction:', { reference: transaction.reference, error: error.message });
              transaction.metadata.retryAttempts = (transaction.metadata.retryAttempts || 0) + 1;
              if (transaction.metadata.retryAttempts >= 3) {
                transaction.status = 'failed';
                transaction.metadata.transferError = 'Max retry attempts reached';
                await Notification.create([{
                  userId: wallet.userId,
                  title: 'Transaction Failed',
                  message: `Transaction of ₦${transaction.amount.toFixed(2)} failed after retries. Ref: ${transaction.reference}`,
                  reference: transaction.reference,
                  type: transaction.type,
                  status: 'failed',
                  createdAt: new Date(),
                }], { session });
              }
            }
          }
          wallet.markModified('transactions');
          await wallet.save({ session });
        });
      } finally {
        session.endSession();
      }
    }
    console.log('Pending transaction retry job completed');
  } catch (error) {
    console.error('Error in retryPendingTransactions:', error.message);
  }
};

exports.manualReconcileTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { reference } = req.body;
      const userId = req.user.id;

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const transaction = wallet.transactions.find((t) => t.reference === reference);
      if (!transaction || transaction.status !== 'pending') {
        throw new Error('Invalid or non-pending transaction');
      }

      const paystackResponse = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
          timeout: 15000,
        }
      );

      if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
        throw new Error('Transaction not successful on payment provider');
      }

      const amountInNaira = parseFloat(paystackResponse.data.data.amount) / 100;
      transaction.status = 'completed';
      transaction.paystackReference = paystackResponse.data.data.reference;
      transaction.metadata.reconciledManually = true;
      transaction.metadata.reconciledAt = new Date().toISOString();
      wallet.balance += amountInNaira;
      wallet.totalDeposits += amountInNaira;

      wallet.markModified('transactions');
      await wallet.save({ session });

      await Notification.create(
        [{
          userId,
          title: 'Funding Confirmed',
          message: `Funding of ₦${amountInNaira.toFixed(2)} confirmed. Ref: ${reference}`,
          reference,
          type: 'funding',
          status: 'completed',
          createdAt: new Date().toISOString(),
        }],
        { session }
      );

      const io = req.app.get('io');
      if (io) {
        io.to(userId.toString()).emit('balanceUpdate', {
          balance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
          transaction: serializeWalletData(wallet).transactions.find(t => t.reference === reference),
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          transaction: serializeWalletData(wallet).transactions.find(t => t.reference === reference),
        },
      });
    });
  } catch (error) {
    logger.error('Manual reconcile error', {
      userId: req.user?.id,
      reference: req.body.reference,
      message: error.message,
    });
    return res.status(500).json({ success: false, error: error.message || 'Failed to reconcile transaction' });
  } finally {
    session.endSession();
  }
};

exports.checkFundingStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { reference } = req.params;
      if (!reference) {
        logger.warn('No reference provided');
        throw new Error('Reference is required');
      }

      let wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        wallet = new Wallet({
          userId: req.user.id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
        });
        await wallet.save({ session });
      }

      let transaction = wallet.transactions.find(
        (t) => t.reference === reference || t.paystackReference === reference
      );

      if (!transaction) {
        logger.info('Transaction not found locally, checking Paystack', { reference });
        const response = await axios.get(
          `https://api.paystack.co/transaction/verify/${reference}`,
          {
            headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
            timeout: 15000,
          }
        );

        if (response.data.status && response.data.data?.status === 'success') {
          const { amount, reference: paystackReference, customer } = response.data.data;
          const amountInNaira = parseFloat(amount) / 100;

          transaction = wallet.transactions.find(
            (t) =>
              t.type === 'deposit' &&
              t.status === 'pending' &&
              t.metadata?.customerEmail === customer.email &&
              t.amount === amountInNaira
          );

          if (!transaction) {
            transaction = {
              type: 'deposit',
              amount: amountInNaira,
              reference: `FUND_${req.user.id}_${uuidv4()}`,
              paystackReference: paystackReference,
              status: 'completed',
              metadata: {
                paymentGateway: 'Paystack',
                customerEmail: customer.email,
                virtualAccount: wallet.virtualAccount,
                reconciledManually: true,
                reconciledAt: new Date().toISOString(),
              },
              createdAt: new Date().toISOString(),
            };
            wallet.transactions.push(transaction);
          } else {
            transaction.status = 'completed';
            transaction.paystackReference = paystackReference;
            transaction.metadata.reconciledManually = true;
            transaction.metadata.reconciledAt = new Date().toISOString();
          }

          wallet.balance += amountInNaira;
          wallet.totalDeposits += amountInNaira;
        } else {
          logger.info('Paystack verification pending', { reference });
          return res.status(200).json({
            success: true,
            message: 'Payment not confirmed',
            data: {
              status: response.data.data?.status || 'pending',
              newBalance: wallet.balance,
              lastSynced: new Date().toISOString(),
            },
          });
        }
      } else if (transaction.status === 'pending' && transaction.paystackReference) {
        const response = await axios.get(
          `https://api.paystack.co/transaction/verify/${transaction.paystackReference}`,
          {
            headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
            timeout: 15000,
          }
        );

        if (response.data.status && response.data.data?.status === 'success') {
          const amountInNaira = parseFloat(response.data.data.amount) / 100;
          transaction.status = 'completed';
          transaction.paystackReference = response.data.data.reference;
          transaction.metadata.reconciledManually = true;
          transaction.metadata.reconciledAt = new Date().toISOString();
          wallet.balance += amountInNaira;
          wallet.totalDeposits += amountInNaira;
        }
      }

      wallet.markModified('transactions');
      await wallet.save({ session });

      if (transaction && transaction.status !== 'pending') {
        await Notification.create(
          [{
            userId: wallet.userId,
            title: transaction.status === 'completed' ? 'Wallet Funded Successfully' : 'Funding Failed',
            message:
              transaction.status === 'completed'
                ? `Your wallet has been funded with ₦${transaction.amount.toFixed(2)} NGN. Ref: ${transaction.reference}`
                : `Funding of ₦${transaction.amount.toFixed(2)} failed. Ref: ${transaction.reference}`,
            reference: transaction.reference,
            type: 'funding',
            status: transaction.status,
            createdAt: new Date().toISOString(),
          }],
          { session }
        );
      }

      const io = req.app.get('io');
      if (io && transaction) {
        io.to(wallet.userId.toString()).emit('balanceUpdate', {
          balance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
          transaction: serializeWalletData(wallet).transactions.find(t => t.reference === transaction.reference),
        });
      }

      return res.status(200).json({
        success: true,
        message:
          transaction?.status === 'completed'
            ? 'Payment confirmed'
            : transaction?.status === 'failed'
              ? 'Payment failed'
              : 'Payment pending',
        data: {
          transaction: serializeWalletData(wallet).transactions.find(t => t.reference === transaction.reference),
          newBalance: wallet.balance,
          lastSynced: new Date().toISOString(),
        },
      });
    });
  } catch (error) {
    logger.error('Check funding status error', {
      reference: req.params.reference,
      message: error.message,
      status: error.response?.status,
    });
    let statusCode = 500;
    let errorMessage = 'Failed to verify transaction';
    if (error.code === 'ECONNABORTED') {
      errorMessage = 'Payment provider timeout';
      statusCode = 504;
    } else if (error.response?.status === 401) {
      errorMessage = 'Invalid Paystack API key';
      statusCode = 401;
    } else if (error.response?.status === 429) {
      errorMessage = 'Too many requests';
      statusCode = 429;
    } else if (error.response?.status === 400 && error.response?.data?.code === 'transaction_not_found') {
      errorMessage = 'Transaction not found on Paystack';
      statusCode = 404;
    }
    return res.status(statusCode).json({ success: false, error: errorMessage });
  } finally {
    session.endSession();
  }
};

exports.reconcileTransactions = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      console.log('Starting transaction reconciliation');
      const wallets = await Wallet.find({
        'transactions.status': 'pending',
      }).session(session);

      const timeoutThreshold = 24 * 60 * 60 * 1000;

      for (const wallet of wallets) {
        for (const tx of wallet.transactions.filter((t) => t.status === 'pending')) {
          const transactionAge = Date.now() - new Date(tx.createdAt).getTime();
          if (transactionAge > timeoutThreshold) {
            console.log('Marking old transaction as failed:', tx.reference);
            tx.status = 'failed';
            tx.metadata.error = 'Transaction timed out';
            wallet.markModified('transactions');

            await Notification.create([{
              userId: wallet.userId,
              title: 'Wallet Funding Timed Out',
              message: `Your wallet funding of ${tx.amount} NGN has timed out. Transaction reference: ${tx.reference}.`,
              reference: tx.reference,
              type: 'funding',
              status: 'failed',
              createdAt: new Date(),
            }], { session });
            console.log('Timeout notification created:', {
              userId: wallet.userId,
              reference: tx.reference,
            });

            continue;
          }

          try {
            const response = await axios.get(
              `https://api.paystack.co/transaction/verify/${tx.reference}`,
              {
                headers: {
                  Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                  'Content-Type': 'application/json',
                },
                timeout: 15000,
              }
            );

            console.log('Reconciliation: Paystack response for', tx.reference, JSON.stringify(response.data, null, 2));

            if (response.data.status && response.data.data?.status === 'success') {
              const amountInNaira = parseFloat(response.data.data.amount) / 100;
              tx.status = 'completed';
              tx.metadata.reconciledManually = true;
              tx.metadata.reconciledAt = new Date();
              wallet.balance += amountInNaira;
              wallet.totalDeposits += amountInNaira;

              wallet.markModified('transactions');

              await Notification.create([{
                userId: wallet.userId,
                title: 'Wallet Funded Successfully',
                message: `Your wallet has been funded with ${amountInNaira} NGN. Transaction reference: ${tx.reference}.`,
                reference: tx.reference,
                type: 'funding',
                status: 'completed',
                createdAt: new Date(),
              }], { session });
              console.log('Reconciliation notification created:', {
                userId: wallet.userId,
                reference: tx.reference,
              });
            } else if (response.data.data?.status === 'failed') {
              tx.status = 'failed';
              tx.metadata.error = response.data.data?.message || 'Payment failed';
              wallet.markModified('transactions');

              await Notification.create([{
                userId: wallet.userId,
                title: 'Wallet Funding Failed',
                message: `Your wallet funding of ${tx.amount} NGN failed. Transaction reference: ${tx.reference}.`,
                reference: tx.reference,
                type: 'funding',
                status: 'failed',
                createdAt: new Date(),
              }], { session });
              console.log('Reconciliation failure notification created:', {
                userId: wallet.userId,
                reference: tx.reference,
              });
            }
          } catch (error) {
            console.error('Reconciliation error for transaction:', {
              reference: tx.reference,
              message: error.message,
              code: error.code,
              response: error.response?.data,
            });
            if (error.response?.status === 401) {
              await Notification.create([{
                userId: wallet.userId,
                title: 'Reconciliation Error',
                message: `Failed to reconcile transaction ${tx.reference} due to invalid Paystack API key.`,
                reference: tx.reference,
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }
            continue;
          }
        }

        await wallet.save({ session });

        const io = req.app.get('io');
        if (io) {
          io.to(wallet.userId.toString()).emit('balanceUpdate', {
            balance: wallet.balance,
            totalDeposits: wallet.totalDeposits,
            lastSynced: new Date().toISOString(),
          });
        }
      }

      console.log('Transaction reconciliation completed');
      return res.status(200).json({
        success: true,
        message: 'Transaction reconciliation completed',
        lastSynced: new Date().toISOString(),
      });
    });
  } catch (error) {
    console.error('Reconciliation error:', {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error during reconciliation' });
  } finally {
    session.endSession();
  }
};


// exports.withdrawFunds = async (req, res) => {
//   const session = await mongoose.startSession();
//   try {
//     await session.withTransaction(async () => {
//       const { amount, accountNumber, accountName, bankCode } = req.body;
//       const userId = req.user?.id;

//       if (!userId) {
//         pino.error('User ID not found in request', { url: req.originalUrl, headers: req.headers });
//         throw new Error('Unauthorized: User ID not found in request');
//       }
//       if (!mongoose.Types.ObjectId.isValid(userId)) {
//         pino.error('Invalid user ID format', { userId });
//         throw new Error('Invalid user ID format');
//       }
//       if (!amount || amount < 100 || !accountNumber || !accountName || !bankCode) {
//         throw new Error('All fields are required. Minimum withdrawal is ₦100.');
//       }
//       if (!/^\d{10}$/.test(accountNumber)) {
//         throw new Error('Account number must be exactly 10 digits');
//       }
//       const bank = CRITICAL_BANKS.find(b => b.code === bankCode); // Use CRITICAL_BANKS instead of PAYSTACK_BANKS
//       if (!bank) {
//         throw new Error('Invalid bank code');
//       }

//       pino.info('Withdrawal request submission', { userId, amount, accountNumber: accountNumber.slice(-4), bankCode });

//       let wallet = await Wallet.findOne({ userId }).session(session);
//       if (!wallet) {
//         pino.warn('No wallet found for user, creating new wallet', { userId });
//         wallet = new Wallet({
//           userId,
//           balance: 0,
//           transactions: [],
//           withdrawalRequests: [],
//         });
//         await wallet.save({ session });
//       }
//       if (wallet.balance < amount) {
//         throw new Error(`Insufficient wallet balance. Available: ₦${wallet.balance.toFixed(2)}, Requested: ₦${amount.toFixed(2)}`);
//       }

//       const reference = `WDR_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
//       const expectedPayoutDate = addBusinessDays(new Date(), 2);

//       const withdrawalRequest = {
//         type: 'withdrawal',
//         amount,
//         reference,
//         status: 'pending',
//         metadata: {
//           accountNumber,
//           accountName,
//           bankName: bank.name,
//           bankCode,
//           requestDate: moment.tz('Africa/Lagos').toDate(),
//           expectedPayoutDate,
//           manualProcessing: true,
//         },
//         createdAt: moment.tz('Africa/Lagos').toDate(),
//       };
//       wallet.withdrawalRequests = wallet.withdrawalRequests || [];
//       wallet.withdrawalRequests.push(withdrawalRequest);
//       wallet.balance -= amount;
//       wallet.markModified('withdrawalRequests');
//       await wallet.save({ session });

//       await Notification.create(
//         [
//           {
//             userId,
//             title: 'Withdrawal Request Submitted',
//             message: `Withdrawal request of ₦${amount.toFixed(2)} to ${accountName} at ${bank.name} submitted. Expect payout by ${moment(expectedPayoutDate).tz('Africa/Lagos').format('MMMM D, YYYY')}.`,
//             reference,
//             type: 'withdrawal',
//             status: 'pending',
//             createdAt: moment.tz('Africa/Lagos').toDate(),
//           },
//         ],
//         { session }
//       );

//       const io = req.app.get('io');
//       if (io) {
//         io.to(userId.toString()).emit('balanceUpdate', {
//           balance: wallet.balance,
//           withdrawalRequest: {
//             amount,
//             reference,
//             status: 'pending',
//             accountNumber,
//             accountName,
//             bankName: bank.name,
//             expectedPayoutDate,
//           },
//         });
//       } else {
//         pino.warn('WebSocket not available for balance update', { userId, reference });
//       }

//       res.status(200).json({
//         success: true,
//         message: `Withdrawal request submitted. Expect payout by ${moment(expectedPayoutDate).tz('Africa/Lagos').format('MMMM D, YYYY')}. If you don’t receive your payout after this date, please contact support.`,
//         data: {
//           reference,
//           amount,
//           accountNumber: accountNumber.slice(-4),
//           accountName,
//           bankName: bank.name,
//           expectedPayoutDate,
//         },
//       });
//     });
//   } catch (error) {
//     pino.error('Withdraw funds error', {
//       userId: req.user?.id,
//       message: error.message,
//       stack: error.stack,
//     });
//     const statusCode = error.message.includes('Unauthorized') ? 401 :
//       error.message.includes('Invalid user ID') ? 400 :
//         error.message.includes('Wallet not found') ? 404 :
//           error.message.includes('Invalid bank code') ? 400 : 400;
//     res.status(statusCode).json({ success: false, error: error.message });
//   } finally {
//     await session.endSession();
//   }
// };



// ============================================================================
// 2. WITHDRAWAL FUNCTION FIX - Add proper locking and validation
// ============================================================================
exports.withdrawFunds = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, accountNumber, accountName, bankCode } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        pino.error('User ID not found in request', { url: req.originalUrl, headers: req.headers });
        throw new Error('Unauthorized: User ID not found in request');
      }
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        pino.error('Invalid user ID format', { userId });
        throw new Error('Invalid user ID format');
      }
      if (!amount || amount < 100 || !accountNumber || !accountName || !bankCode) {
        throw new Error('All fields are required. Minimum withdrawal is ₦100.');
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        throw new Error('Account number must be exactly 10 digits');
      }
      const bank = CRITICAL_BANKS.find(b => b.code === bankCode);
      if (!bank) {
        throw new Error('Invalid bank code');
      }

      pino.info('Withdrawal request submission', { userId, amount, accountNumber: accountNumber.slice(-4), bankCode });

      // ✅ CRITICAL: Use session-based locking to prevent race conditions
      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        pino.warn('No wallet found for user, creating new wallet', { userId });
        wallet = new Wallet({
          userId,
          balance: 0,
          transactions: [],
          withdrawalRequests: [],
        });
        await wallet.save({ session });
      }

      // ✅ CRITICAL: Calculate available balance with session lock
      const balanceDetails = wallet.getBalanceDetails();

      pino.info('Balance check for withdrawal', {
        userId,
        requestedAmount: amount,
        totalBalance: balanceDetails.totalBalance,
        pendingWithdrawals: balanceDetails.pendingWithdrawals,
        availableBalance: balanceDetails.availableBalance,
      });

      // ✅ CRITICAL: Check if user has sufficient available balance
      if (balanceDetails.availableBalance < amount) {
        throw new Error(
          `Insufficient available balance. Available: ₦${balanceDetails.availableBalance.toFixed(2)}, ` +
          `Pending withdrawals: ₦${balanceDetails.pendingWithdrawals.toFixed(2)}, ` +
          `Requested: ₦${amount.toFixed(2)}`
        );
      }

      // ✅ ADDED: Additional check to ensure total balance is also sufficient
      // (This prevents issues if balance becomes negative due to other operations)
      if (wallet.balance < amount) {
        throw new Error(
          `Insufficient wallet balance. Current balance: ₦${wallet.balance.toFixed(2)}, ` +
          `Requested: ₦${amount.toFixed(2)}`
        );
      }

      const reference = `WDR_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const expectedPayoutDate = addBusinessDays(new Date(), 2);

      const withdrawalRequest = {
        type: 'withdrawal',
        amount,
        reference,
        status: 'pending',
        metadata: {
          accountNumber,
          accountName,
          bankName: bank.name,
          bankCode,
          requestDate: moment.tz('Africa/Lagos').toDate(),
          expectedPayoutDate,
          manualProcessing: true,
        },
        createdAt: moment.tz('Africa/Lagos').toDate(),
      };

      wallet.withdrawalRequests = wallet.withdrawalRequests || [];
      wallet.withdrawalRequests.push(withdrawalRequest);

      // ✅ CORRECT: Do NOT deduct balance here - only deduct after admin approval
      wallet.markModified('withdrawalRequests');
      await wallet.save({ session });

      await Notification.create(
        [
          {
            userId,
            title: 'Withdrawal Request Submitted',
            message: `Withdrawal request of ₦${amount.toFixed(2)} to ${accountName} at ${bank.name} submitted. Expect payout by ${moment(expectedPayoutDate).tz('Africa/Lagos').format('MMMM D, YYYY')}.`,
            reference,
            type: 'withdrawal',
            status: 'pending',
            createdAt: moment.tz('Africa/Lagos').toDate(),
          },
        ],
        { session }
      );

      const io = req.app.get('io');
      if (io) {
        io.to(userId.toString()).emit('balanceUpdate', {
          balance: wallet.balance,
          availableBalance: wallet.getAvailableBalance(),
          pendingWithdrawals: balanceDetails.pendingWithdrawals,
          withdrawalRequest: {
            amount,
            reference,
            status: 'pending',
            accountNumber,
            accountName,
            bankName: bank.name,
            expectedPayoutDate,
          },
        });
      } else {
        pino.warn('WebSocket not available for balance update', { userId, reference });
      }

      res.status(200).json({
        success: true,
        message: `Withdrawal request submitted. Expect payout by ${moment(expectedPayoutDate).tz('Africa/Lagos').format('MMMM D, YYYY')}. If you don't receive your payout after this date, please contact support.`,
        data: {
          reference,
          amount,
          accountNumber: accountNumber.slice(-4),
          accountName,
          bankName: bank.name,
          expectedPayoutDate,
          balanceDetails: {
            totalBalance: wallet.balance,
            availableBalance: wallet.getAvailableBalance(),
            pendingWithdrawals: balanceDetails.pendingWithdrawals,
          },
        },
      });
    });
  } catch (error) {
    pino.error('Withdraw funds error', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
    });
    const statusCode = error.message.includes('Unauthorized') ? 401 :
      error.message.includes('Invalid user ID') ? 400 :
        error.message.includes('Wallet not found') ? 404 :
          error.message.includes('Invalid bank code') ? 400 :
            error.message.includes('Insufficient') ? 400 : 400;
    res.status(statusCode).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
};

exports.verifyAccount = async (req, res) => {
  try {
    const { bankCode, accountNumber } = req.body;
    const userId = req.user.id;

    console.log('Verifying account:', { userId, bankCode, accountNumber });

    if (!bankCode || !accountNumber) {
      return res.status(422).json({
        success: false,
        error: 'Bank code and account number are required',
      });
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(422).json({
        success: false,
        error: 'Account number must be exactly 10 digits',
      });
    }

    const bankValidation = CRITICAL_BANKS.find(bank => bank.code === bankCode);
    if (!bankValidation) {
      console.warn(`Unknown bank code provided: ${bankCode}`);
      return res.status(422).json({
        success: false,
        error: 'Invalid bank code',
        availableBanks: CRITICAL_BANKS.slice(0, 5),
      });
    }

    const headers = {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Escrow-App/1.0',
      'Accept': 'application/json',
      'Cache-Control': 'no-cache',
    };

    try {
      console.log('Attempting account verification with Paystack...');
      const verificationUrl = `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`;
      const response = await axios.get(verificationUrl, {
        headers,
        timeout: 30000,
        maxRedirects: 3,
        validateStatus: (status) => status < 500,
      });

      console.log('Paystack verification response:', {
        status: response.status,
        success: response.data?.status,
        hasData: !!response.data?.data,
        accountName: response.data?.data?.account_name,
      });

      if (response.status === 200 && response.data?.status === true) {
        const accountName = response.data.data?.account_name;
        if (!accountName || accountName.trim() === '') {
          return res.status(422).json({
            success: false,
            error: 'Account verification returned empty account name',
          });
        }

        console.log('Account verification successful:', { accountNumber, accountName });

        return res.status(200).json({
          success: true,
          accountName: accountName.trim(),
          bankCode,
          accountNumber,
        });
      }

      return res.status(502).json({
        success: false,
        error: 'Unable to verify account at this time. Please try again later.',
      });
    } catch (error) {
      console.error('Account verification error:', {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        data: error.response?.data,
      });

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return res.status(504).json({
          success: false,
          error: 'Verification request timed out. Please try again.',
        });
      }

      if (error.response?.status === 401) {
        return res.status(500).json({
          success: false,
          error: 'Payment gateway authentication failed. Please contact support.',
        });
      }

      if (error.response?.status === 429) {
        return res.status(429).json({
          success: false,
          error: 'Too many verification requests. Please wait a moment and try again.',
        });
      }

      return res.status(502).json({
        success: false,
        error: 'Account verification service temporarily unavailable. Please try again later.',
      });
    }
  } catch (error) {
    console.error('Unexpected error in verifyAccount:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later',
    });
  }
};

const retryAsync = async (fn, maxRetries = 3, initialDelay = 1000) => {
  let lastError = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = initialDelay * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
};

const addBusinessDays = (date, days) => {
  let currentDate = moment.tz(date, 'Africa/Lagos').startOf('day');
  let businessDaysAdded = 0;

  while (businessDaysAdded < days) {
    currentDate.add(1, 'day');
    if (currentDate.day() !== 0 && currentDate.day() !== 6) {
      businessDaysAdded++;
    }
  }

  return currentDate.toDate();
};

exports.getPendingWithdrawals = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const userId = req.user?.id;
      if (!userId) {
        pino.error('User ID not found in request', { url: req.originalUrl, headers: req.headers });
        return res.status(401).json({ success: false, error: 'Unauthorized: No user ID provided' });
      }
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        pino.error('Invalid user ID format', { userId });
        return res.status(400).json({ success: false, error: 'Invalid user ID format' });
      }

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        pino.warn('No wallet found for user, creating new wallet', { userId });
        wallet = new Wallet({
          userId,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          withdrawalRequests: [],
          lastSynced: new Date(),
        });
        await wallet.save({ session });
        pino.info('Created new wallet for user', { userId, walletId: wallet._id });
      }

      const pendingWithdrawals = (wallet.withdrawalRequests || [])
        .filter(w => w.status === 'pending')
        .map(w => ({
          reference: w.reference,
          amount: w.amount,
          accountNumber: w.metadata.accountNumber?.slice(-4) || 'N/A',
          accountName: w.metadata.accountName || 'N/A',
          requestDate: w.createdAt,
          expectedPayoutDate: moment(w.metadata.expectedPayoutDate).tz('Africa/Lagos').toDate(),
          timeRemaining: Math.max(0, moment(w.metadata.expectedPayoutDate).tz('Africa/Lagos').diff(moment.tz('Africa/Lagos'))),
        }));

      res.status(200).json({
        success: true,
        data: { pendingWithdrawals },
      });
    });
  } catch (error) {
    pino.error('Get pending withdrawals error', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
      mongoError: error.name === 'MongoServerError' ? error.code : null,
    });
    res.status(500).json({ success: false, error: 'Failed to fetch pending withdrawals' });
  } finally {
    await session.endSession();
  }
};

exports.checkPaystackBalance = async (req, res) => {
  try {
    const response = await axios.get('https://api.paystack.co/balance', {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (!response.data?.status) {
      throw new Error('Invalid response from Paystack');
    }

    const balanceData = response.data.data;
    let transferBalance = 0;
    let revenueBalance = 0;
    let currency = 'NGN';

    if (Array.isArray(balanceData)) {
      transferBalance = balanceData.find(b => b.balance_type === 'transfers')?.balance / 100 || 0;
      revenueBalance = balanceData.find(b => b.balance_type === 'revenue')?.balance / 100 || 0;
      currency = balanceData.find(b => b.currency)?.currency || 'NGN';
    } else if (typeof balanceData === 'object') {
      transferBalance = balanceData.transfers?.balance / 100 || balanceData.balance / 100 || 0;
      revenueBalance = balanceData.revenue?.balance / 100 || balanceData.balance / 100 || 0;
      currency = balanceData.currency || 'NGN';
    }

    logger.info('Paystack balance retrieved', {
      transferBalance,
      revenueBalance,
      currency,
      rawData: balanceData,
    });

    return res.status(200).json({
      success: true,
      data: {
        currency,
        transferBalance,
        revenueBalance,
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to check Paystack balance', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return res.status(503).json({
      success: false,
      error: 'Unable to check payment gateway balance',
      errorCode: 'BALANCE_CHECK_FAILED',
    });
  }
};

exports.verifyWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { event, data } = req.body;
      if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event)) {
        return res.status(200).json({ status: 'success' });
      }

      const { reference, amount } = data;
      if (!reference || !amount) {
        throw new Error('Invalid webhook payload');
      }

      const wallet = await Wallet.findOne({ 'transactions.reference': reference }).session(session);
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const transaction = wallet.transactions.find(t => t.reference === reference);
      if (!transaction || transaction.status !== 'pending') {
        return res.status(200).json({ status: 'success' });
      }

      const amountInNaira = parseFloat(amount) / 100;
      transaction.status = event === 'transfer.success' ? 'completed' : 'failed';
      transaction.metadata.webhookEvent = event;

      if (event !== 'transfer.success') {
        wallet.balance += amountInNaira;
      }

      wallet.markModified('transactions');
      await wallet.save({ session });

      const notification = {
        userId: wallet.userId,
        title: event === 'transfer.success' ? 'Withdrawal Successful' : 'Withdrawal Failed',
        message: event === 'transfer.success'
          ? `Withdrawal of ₦${amountInNaira.toFixed(2)} completed. Ref: ${reference}`
          : `Withdrawal of ₦${amountInNaira.toFixed(2)} failed and refunded. Ref: ${reference}`,
        reference,
        type: 'withdrawal',
        status: event === 'transfer.success' ? 'completed' : 'failed',
      };
      await Notification.create([notification], { session });

      const io = req.app.get('io');
      if (io) {
        io.to(wallet.userId.toString()).emit('balanceUpdate', {
          balance: wallet.balance,
          transaction: { amount: amountInNaira, reference, status: transaction.status },
        });
      }

      res.status(200).json({ status: 'success' });
    });
  } catch (error) {
    console.error('Withdrawal webhook error:', error.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    session.endSession();
  }
};

exports.getPaystackBanks = async (req, res) => {
  try {
    console.log('Fetching bank list...');
    const response = await axios.get('https://api.paystack.co/bank', {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      params: {
        country: 'nigeria',
        use_cursor: false,
        perPage: 100,
      },
      timeout: 10000,
    });

    if (response.data?.status && Array.isArray(response.data.data)) {
      const banks = response.data.data
        .map(bank => ({
          name: bank.name.trim(),
          code: bank.code,
          active: bank.active !== false,
          type: bank.type || 'commercial',
        }))
        .filter(bank => bank.name && bank.code && bank.active)
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.status(200).json({
        success: true,
        data: banks,
        source: 'paystack_api',
        count: banks.length,
      });
    }

    console.log('Using fallback bank list due to API failure');
    return res.status(200).json({
      success: true,
      data: CRITICAL_BANKS.sort((a, b) => a.name.localeCompare(b.name)),
      source: 'fallback',
      message: 'Using fallback bank list - API temporarily unavailable',
      fallback: true,
      count: CRITICAL_BANKS.length,
    });
  } catch (error) {
    console.error('Get banks error:', {
      message: error.message,
      stack: error.stack,
    });
    return res.status(200).json({
      success: true,
      data: CRITICAL_BANKS.sort((a, b) => a.name.localeCompare(b.name)),
      source: 'fallback',
      message: 'Using fallback bank list due to system error',
      fallback: true,
      count: CRITICAL_BANKS.length,
    });
  }
};

exports.getWalletTransactions = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      logger.info('Fetching wallet transactions for user', { userId: req.user.id });

      let wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        logger.warn('Wallet not found for user, creating new wallet', { userId: req.user.id });
        const user = await User.findById(req.user.id).session(session);
        if (!user) {
          logger.error('User not found during wallet creation', { userId: req.user.id });
          return res.status(404).json({ success: false, error: 'User not found' });
        }

        wallet = new Wallet({
          userId: req.user.id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
        });
        await wallet.save({ session });
        logger.info('Wallet created', { userId: req.user.id, walletId: wallet._id });
      }

      const transactions = Array.isArray(wallet.transactions)
        ? wallet.transactions
          .map(tx => ({
            _id: tx._id,
            type: tx.type || 'unknown',
            amount: parseFloat(tx.amount) || 0,
            status: tx.status || 'pending',
            reference: tx.reference || '',
            paystackReference: tx.paystackReference || '',
            createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : new Date(tx.createdAt || Date.now()).toISOString(),
            metadata: tx.metadata || {},
          }))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        : [];

      logger.info('Transactions retrieved', { userId: req.user.id, count: transactions.length, transactions });

      res.status(200).json({
        success: true,
        data: {
          transactions,
        },
      });
    });
  } catch (error) {
    logger.error('Get transactions error', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
  } finally {
    await session.endSession();
  }
};

exports.monitorPaystackBalance = async () => {
  try {
    const balanceResponse = await axios.get('https://api.paystack.co/balance', {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    if (!balanceResponse.data?.status) {
      throw new Error('Failed to check Paystack balance');
    }

    const revenueBalance = balanceResponse.data.data.find(b => b.balance_type === 'revenue')?.balance / 100 || 0;
    const minimumBalance = 100;

    if (revenueBalance < minimumBalance) {
      console.warn('Low Paystack revenue balance:', { revenueBalance });
      await Notification.create({
        userId: null,
        title: 'Low Paystack Revenue Balance',
        message: `Paystack revenue balance is ₦${revenueBalance.toFixed(2)}. Please top up to ensure smooth operations.`,
        type: 'system',
        status: 'warning',
        reference: null,
      });
    }

    console.log('Paystack balance check completed:', { revenueBalance });
  } catch (error) {
    console.error('Paystack balance monitor error:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    await Notification.create({
      userId: null,
      title: 'Paystack Balance Check Failure',
      message: `Failed to check Paystack balance: ${error.message}`,
      type: 'system',
      status: 'error',
      reference: null,
    });
  }
};