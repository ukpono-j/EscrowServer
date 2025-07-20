const mongoose = require('mongoose');
const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const Notification = require('../modules/Notification');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 600 });
const Bottleneck = require('bottleneck');

const limiter = new Bottleneck({
  maxConcurrent: 10,
  minTime: 100,
});

const CRITICAL_BANKS = [
  { name: "Access Bank", code: "044" },
  { name: "Opay", code: "999992" },
  { name: "Kuda Bank", code: "090267" },
  { name: "Zenith Bank", code: "057" },
  { name: "Moniepoint Microfinance Bank", code: "50515" },
  { name: "Palmpay", code: "999991" },
  { name: "First Bank", code: "011" },
  { name: "GTBank", code: "058" },
  { name: "UBA", code: "033" },
  { name: "Fidelity Bank", code: "070" },
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

const transferToPaystackTransferBalance = async (amount, reason = 'Fund Transfer Balance', session) => {
  return limiter.schedule(async () => {
    try {
      console.log('Initiating Paystack transfer:', { amount, reason });

      const response = await axios.post(
        'https://api.paystack.co/transfer',
        {
          source: 'balance',
          amount: Math.round(amount * 100),
          currency: 'NGN',
          reason,
          recipient: 'balance',
        },
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      if (!response.data.status) {
        throw new Error(response.data.message || 'Failed to transfer to Paystack balance');
      }

      console.log('Transfer successful:', response.data.data);
      return { status: true, data: response.data.data };
    } catch (error) {
      console.error('Transfer error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });

      await Notification.create(
        {
          userId: null,
          title: 'Transfer Failure',
          message: `Failed to transfer ₦${amount.toFixed(2)} to Paystack balance: ${error.message}`,
          type: 'system',
          status: 'error',
          createdAt: new Date(),
        },
        { session }
      );

      throw error;
    }
  });
};

exports.checkFundingReadiness = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { id: userId } = req.user;

      const user = await User.findById(userId).session(session);
      if (!user) {
        console.warn('User not found in database', { userId });
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      try {
        const balanceResponse = await axios.get('https://api.paystack.co/balance', {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 10000,
        });

        if (!balanceResponse.data?.status) {
          console.error('Paystack API key invalid', { response: balanceResponse.data });
          return res.status(503).json({
            success: false,
            error: 'Payment provider configuration issue. Please try again later.',
          });
        }
      } catch (error) {
        console.error('Paystack API error during readiness check:', {
          userId,
          message: error.message,
          status: error.response?.status,
        });
        return res.status(503).json({
          success: false,
          error: 'Failed to verify payment provider. Please try again later.',
        });
      }

      if (!user.paystackCustomerCode) {
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
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
              timeout: 10000,
            }
          );

          if (!customerResponse.data.status) {
            console.error('Failed to create Paystack customer:', customerResponse.data);
            return res.status(503).json({
              success: false,
              error: 'Failed to initialize payment profile. Please try again later.',
            });
          }

          user.paystackCustomerCode = customerResponse.data.data.customer_code;
          await user.save({ session });
        } catch (error) {
          console.error('Error creating Paystack customer:', {
            userId,
            message: error.message,
            status: error.response?.status,
          });
          return res.status(503).json({
            success: false,
            error: 'Failed to initialize payment profile. Please try again later.',
          });
        }
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
        });
        await wallet.save({ session });
      }

      if (!wallet.virtualAccount?.account_number) {
        const banksToTry = process.env.NODE_ENV === 'production'
          ? ['wema-bank', 'access-bank']
          : ['wema-bank'];

        let accountResponse = null;
        for (const bank of banksToTry) {
          try {
            accountResponse = await axios.post(
              'https://api.paystack.co/dedicated_account',
              {
                customer: user.paystackCustomerCode,
                preferred_bank: bank,
              },
              {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                timeout: 10000,
              }
            );
            if (accountResponse.data.status) break;
          } catch (error) {
            console.warn(`Failed to create virtual account with ${bank}:`, error.message);
          }
        }

        if (!accountResponse?.data?.status) {
          console.error('Failed to create virtual account', { userId });
          return res.status(503).json({
            success: false,
            error: 'Unable to create virtual account. Please try again later.',
          });
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

      return res.status(200).json({
        success: true,
        message: 'Funding system is ready.',
        data: {
          customerCode: user.paystackCustomerCode,
          virtualAccount: wallet.virtualAccount,
        },
      });
    });
  } catch (error) {
    console.error('Funding readiness check error:', {
      userId: req.user?.id,
      message: error.message,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to check funding readiness. Please try again later.',
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
        if (!['dedicatedaccount.credit', 'charge.success'].includes(event)) {
          console.log('Ignoring non-relevant Paystack event:', {
            event,
            time: new Date().toISOString(),
          });
          return res.status(200).json({ status: 'success' });
        }

        const { reference, amount, status, customer, account_details } = data;
        if (!reference || !amount || !status || !customer?.email) {
          console.error('Invalid webhook payload:', {
            event,
            data,
            time: new Date().toISOString(),
          });
          return res.status(400).json({ success: false, error: 'Invalid webhook payload' });
        }

        console.log('Processing webhook event:', {
          event,
          reference,
          amount,
          customerEmail: customer.email,
          time: new Date().toISOString(),
        });

        const user = await User.findOne({ email: customer.email }).session(session);
        if (!user) {
          console.error('User not found for email:', {
            email: customer.email,
            time: new Date().toISOString(),
          });
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
          t => t.paystackReference === reference && t.status === 'completed'
        );
        if (existingTransaction) {
          console.log('Transaction already processed:', {
            reference,
            time: new Date().toISOString(),
          });
          return res.status(200).json({ status: 'success' });
        }

        const amountInNaira = parseFloat(amount) / 100;
        let transaction = wallet.transactions.find(
          t =>
            t.paystackReference === reference ||
            (t.metadata?.virtualAccountId === account_details?.id && t.status === 'pending') ||
            (t.amount === amountInNaira && t.status === 'pending' && !t.paystackReference)
        );

        if (!transaction) {
          console.log('Creating new transaction for:', {
            reference,
            time: new Date().toISOString(),
          });
          transaction = {
            type: 'deposit',
            amount: amountInNaira,
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
          console.log('Updating transaction with paystackReference:', {
            reference,
            transactionReference: transaction.reference,
            time: new Date().toISOString(),
          });
          transaction.paystackReference = reference;
        }

        if (status === 'success') {
          // Verify Paystack balance if not bypassed
          if (process.env.BYPASS_PAYSTACK_BALANCE_CHECK !== 'true') {
            try {
              const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                timeout: 10000,
              });

              if (!balanceResponse.data.status) {
                throw new Error('Failed to fetch Paystack balance');
              }

              const availableBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100;
              if (availableBalance < amountInNaira) {
                console.warn('Insufficient Paystack balance:', {
                  availableBalance,
                  required: amountInNaira,
                  reference,
                  time: new Date().toISOString(),
                });
                transaction.status = 'pending';
                transaction.metadata.pendingReason = 'Insufficient Paystack balance, awaiting retry';
                await Notification.create([{
                  userId: wallet.userId,
                  title: 'Funding Pending',
                  message: `Funding of ₦${amountInNaira.toFixed(2)} is pending due to insufficient Paystack balance. Ref: ${reference}`,
                  transactionId: transaction.reference,
                  type: 'funding',
                  status: 'pending',
                  createdAt: new Date(),
                }], { session });
              } else {
                transaction.status = 'completed';
                wallet.balance += amountInNaira;
                wallet.totalDeposits += amountInNaira;
                console.log('Wallet funded successfully:', {
                  amount: amountInNaira,
                  reference,
                  newBalance: wallet.balance,
                  time: new Date().toISOString(),
                });
              }
            } catch (balanceError) {
              console.error('Paystack balance check error:', {
                message: balanceError.message,
                stack: balanceError.stack,
                reference,
                time: new Date().toISOString(),
              });
              transaction.status = 'pending';
              transaction.metadata.pendingReason = 'Balance check failed, awaiting retry';
              await Notification.create([{
                userId: wallet.userId,
                title: 'Funding Pending',
                message: `Funding of ₦${amountInNaira.toFixed(2)} is pending due to a system issue. Ref: ${reference}`,
                transactionId: transaction.reference,
                type: 'funding',
                status: 'pending',
                createdAt: new Date(),
              }], { session });
            }
          } else {
            transaction.status = 'completed';
            wallet.balance += amountInNaira;
            wallet.totalDeposits += amountInNaira;
            console.log('Wallet funded directly (balance check bypassed):', {
              amount: amountInNaira,
              reference,
              newBalance: wallet.balance,
              time: new Date().toISOString(),
            });
          }
        } else {
          transaction.status = 'failed';
          transaction.metadata.error = 'Transaction failed at Paystack';
          console.log('Transaction failed:', {
            reference,
            status,
            time: new Date().toISOString(),
          });
        }

        transaction.amount = amountInNaira;
        wallet.markModified('transactions');
        await wallet.save({ session });

        // Clear cache to ensure fresh balance on next fetch
        const cacheKey = `wallet_balance_${wallet.userId}`;
        cache.del(cacheKey);
        console.log('Cache cleared for wallet:', { cacheKey, time: new Date().toISOString() });

        if (transaction.status !== 'pending') {
          await Notification.create([{
            userId: wallet.userId,
            title: transaction.status === 'completed' ? 'Wallet Funded' : 'Funding Failed',
            message: transaction.status === 'completed'
              ? `Wallet funded with ₦${amountInNaira.toFixed(2)}. Ref: ${transaction.reference}`
              : `Funding of ₦${amountInNaira.toFixed(2)} failed. Ref: ${transaction.reference}`,
            transactionId: transaction.reference,
            type: 'funding',
            status: transaction.status,
            createdAt: new Date(),
          }], { session });
        }

        const io = req.app.get('io');
        if (io) {
          const retryEmit = async (attempts = 10, delay = 3000) => {
            for (let i = 0; i < attempts; i++) {
              try {
                const socketsInRoom = await io.in(wallet.userId.toString()).allSockets();
                if (socketsInRoom.size > 0) {
                  io.to(wallet.userId.toString()).emit('balanceUpdate', {
                    balance: wallet.balance,
                    totalDeposits: wallet.totalDeposits,
                    transaction: {
                      amount: amountInNaira,
                      reference: transaction.reference,
                      status: transaction.status,
                      type: transaction.type,
                      createdAt: transaction.createdAt,
                      paystackReference: transaction.paystackReference,
                    },
                  });
                  console.log('Balance update emitted:', {
                    userId: wallet.userId,
                    balance: wallet.balance,
                    reference: transaction.reference,
                    attempt: i + 1,
                    time: new Date().toISOString(),
                  });
                  return true;
                } else {
                  console.warn('No active sockets for user:', {
                    userId: wallet.userId,
                    attempt: i + 1,
                    time: new Date().toISOString(),
                  });
                }
              } catch (error) {
                console.error('Error emitting balance update:', {
                  userId: wallet.userId,
                  attempt: i + 1,
                  error: error.message,
                  time: new Date().toISOString(),
                });
              }
              await new Promise(resolve => setTimeout(resolve, delay));
            }
            return false;
          };

          const emitted = await retryEmit();
          if (!emitted) {
            console.warn('Failed to emit balance update after retries:', {
              userId: wallet.userId,
              time: new Date().toISOString(),
            });
            await Notification.create([{
              userId: wallet.userId,
              title: 'Balance Update Issue',
              message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
              type: 'system',
              status: 'error', // Changed from 'warning' to 'error'
              createdAt: new Date(),
            }], { session });
          }
        } else {
          console.error('Socket.io instance not available', {
            time: new Date().toISOString(),
          });
          await Notification.create([{
            userId: wallet.userId,
            title: 'Balance Update Issue',
            message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
            type: 'system',
            status: 'error', // Changed from 'warning' to 'error'
            createdAt: new Date(),
          }], { session });
        }

        return res.status(200).json({ status: 'success' });
      });
    } catch (error) {
      console.error('Webhook error:', {
        event: req.body.event,
        reference: req.body.data?.reference,
        message: error.message,
        stack: error.stack,
        time: new Date().toISOString(),
      });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      await session.endSession();
    }
  });
};

exports.getWalletBalance = async (req, res) => {
  let session;
  try {
    if (!req.user?.id) {
      console.error('No user ID in request:', { user: req.user });
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: No user ID provided',
      });
    }

    const maxRetries = 3;
    let retries = 0;
    while (mongoose.connection.readyState !== 1 && retries < maxRetries) {
      console.log(`Database not connected (state: ${mongoose.connection.readyState}), retrying (${retries + 1}/${maxRetries})...`, {
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        dbName: mongoose.connection.name,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      retries++;
    }
    if (mongoose.connection.readyState !== 1) {
      console.error('Database connection failed after retries', {
        retryAttempts: maxRetries,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        dbName: mongoose.connection.name,
      });
      throw new Error('Database connection failed after retries');
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const cacheKey = `wallet_balance_${req.user.id}`;
      const cachedBalance = cache.get(cacheKey);
      if (cachedBalance) {
        console.log('Returning cached wallet balance:', { userId: req.user.id, cacheKey });
        return res.status(200).json({
          success: true,
          data: cachedBalance,
          source: 'cache',
        });
      }

      let wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        wallet = new Wallet({
          userId: req.user.id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          virtualAccount: null,
          lastSynced: new Date(),
        });
        await wallet.save({ session });
        console.log('Created new wallet:', { userId: req.user.id, walletId: wallet._id });
      }

      const user = await User.findById(req.user.id).session(session);
      if (!user) {
        console.error('User not found:', { userId: req.user.id });
        return res.status(404).json({
          success: false,
          error: 'User not found',
        });
      }

      const syncInterval = 5 * 60 * 1000; // 5 minutes
      const now = new Date();
      let syncWarning = null;
      if (!wallet.lastSynced || (now - new Date(wallet.lastSynced)) > syncInterval) {
        try {
          console.log('Attempting Paystack sync for user:', req.user.id);
          await wallet.syncBalanceWithPaystack();
          console.log('Paystack sync completed for user:', req.user.id);
        } catch (syncError) {
          console.error('Paystack sync error:', {
            userId: req.user.id,
            message: syncError.message,
            stack: syncError.stack,
            paystackResponse: syncError.response?.data,
          });
          syncWarning = 'Balance sync with payment provider failed. Displaying last known balance.';
        }
      } else {
        console.log('Skipping Paystack sync, using recent balance:', { userId: req.user.id, lastSynced: wallet.lastSynced });
      }

      await wallet.save({ session });

      const walletPlain = wallet.toObject();
      const responseData = {
        user: {
          _id: user._id,
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          email: user.email,
          phoneNumber: user.phoneNumber || '',
          dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
          paystackCustomerCode: user.paystackCustomerCode || null,
        },
        wallet: {
          balance: walletPlain.balance || 0,
          totalDeposits: walletPlain.totalDeposits || 0,
          currency: walletPlain.currency || 'NGN',
          walletId: walletPlain._id,
          virtualAccount: walletPlain.virtualAccount
            ? {
              account_name: walletPlain.virtualAccount.account_name || null,
              account_number: walletPlain.virtualAccount.account_number || null,
              bank_name: walletPlain.virtualAccount.bank_name || null,
              provider: walletPlain.virtualAccount.provider || 'Paystack',
              provider_reference: walletPlain.virtualAccount.provider_reference || null,
              dedicated_reference: walletPlain.virtualAccount.dedicated_reference || null,
            }
            : null,
          transactions: walletPlain.transactions || [],
          lastSynced: walletPlain.lastSynced ? walletPlain.lastSynced.toISOString() : new Date().toISOString(),
        },
      };

      cache.set(cacheKey, responseData);
      res.status(200).json({
        success: true,
        data: responseData,
        ...(syncWarning && { warning: syncWarning }),
      });
    });
  } catch (error) {
    console.error('Get balance error:', {
      userId: req.user?.id || 'unknown',
      message: error.message,
      stack: error.stack,
      errorDetails: error.response?.data || error,
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch balance',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    if (session) await session.endSession();
  }
};

exports.initiateFunding = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, email, phoneNumber, userId } = req.body;
      const amountNum = parseFloat(amount);

      if (!amountNum || amountNum <= 0 || amountNum < 100) {
        return res.status(400).json({ success: false, error: 'Invalid or missing amount. Minimum is ₦100.' });
      }

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'Invalid or missing email' });
      }

      if (!phoneNumber || !/^(0\d{10}|\+234\d{10})$/.test(phoneNumber)) {
        return res.status(400).json({ success: false, error: 'Invalid or missing phone number' });
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
        });
        await wallet.save({ session });
      }

      const user = await User.findById(userId).session(session);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      let customerCode = user.paystackCustomerCode;
      if (!customerCode) {
        try {
          const customerResponse = await axios.post(
            'https://api.paystack.co/customer',
            {
              email,
              first_name: user.firstName || 'Unknown',
              last_name: user.lastName || 'Unknown',
              phone: phoneNumber,
            },
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
              timeout: 15000,
            }
          );

          if (!customerResponse.data.status) {
            throw new Error(customerResponse.data.message || 'Failed to create Paystack customer');
          }

          customerCode = customerResponse.data.data.customer_code;
          user.paystackCustomerCode = customerCode;
          await user.save({ session });
        } catch (customerError) {
          console.error('Failed to create Paystack customer:', {
            userId,
            message: customerError.message,
            status: customerError.response?.status,
            response: customerError.response?.data,
          });
          if (customerError.response?.status === 401) {
            await Notification.create([{
              userId,
              title: 'Payment Provider Error',
              message: 'Failed to initiate funding due to invalid payment provider configuration. Please contact support.',
              type: 'system',
              status: 'error',
              createdAt: new Date(),
            }], { session });
            return res.status(502).json({
              success: false,
              error: 'Payment provider authentication failed. Please contact support.',
            });
          }
          throw customerError;
        }
      }

      let virtualAccount = wallet.virtualAccount;
      if (!virtualAccount || !virtualAccount.account_number || !virtualAccount.bank_name) {
        const banksToTry = process.env.NODE_ENV === 'production'
          ? ['wema-bank', 'access-bank', 'gtbank', 'sterling-bank']
          : ['wema-bank', 'titan-paystack'];

        let accountResponse = null;
        for (const bank of banksToTry) {
          try {
            accountResponse = await axios.post(
              'https://api.paystack.co/dedicated_account',
              {
                customer: customerCode,
                split_config: { subaccount: null },
              },
              {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
                timeout: 20000,
              }
            );
            if (accountResponse.data.status) break;
          } catch (bankError) {
            console.warn(`Bank ${bank} failed:`, bankError.message);
          }
        }

        if (!accountResponse?.data?.status) {
          throw new Error('Unable to create virtual account');
        }

        const accountData = accountResponse.data.data;
        virtualAccount = {
          account_name: accountData.account_name,
          account_number: accountData.account_number,
          bank_name: accountData.bank.name,
          provider: 'Paystack',
          provider_reference: accountData.id,
          dedicated_reference: accountData.dedicated_account?.assignment?.integration_reference || null,
          created_at: new Date(),
          active: true,
        };

        wallet.virtualAccount = virtualAccount;
      }

      const reference = `FUND_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const transaction = {
        type: 'deposit',
        amount: amountNum,
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'Paystack',
          customerEmail: email,
          customerPhone: phoneNumber,
          virtualAccount,
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
          transactionId: reference,
          type: 'funding',
          status: 'pending',
          createdAt: new Date(),
        }],
        { session }
      );

      res.status(200).json({
        success: true,
        message: 'Virtual account ready for funding',
        data: {
          virtualAccount,
          reference,
          amount: amountNum,
          customerCode,
          instructions: {
            step1: `Transfer ₦${amountNum.toFixed(2)} to the account details below`,
            step2: 'Your wallet will be credited automatically within 5 minutes',
            step3: 'You will receive a notification once payment is confirmed',
          },
        },
      });
    });
  } catch (error) {
    console.error('Funding error:', { userId: req.user?.id, message: error.message });
    res.status(500).json({ success: false, error: error.message || 'Failed to initiate funding' });
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
          for (const transaction of wallet.transactions.filter(t => t.status === 'pending' && t.metadata?.pendingReason === 'Insufficient Paystack balance, awaiting retry')) {
            try {
              // Only retry transactions that require balance transfers (e.g., withdrawals, not deposits)
              if (transaction.type !== 'deposit') {
                const transferResult = await transferToPaystackTransferBalance(transaction.amount, `Retry for ${transaction.reference}`, session);
                if (transferResult.status) {
                  transaction.status = 'completed';
                  wallet.balance += transaction.amount;
                  wallet.totalDeposits += transaction.amount;
                  transaction.metadata.transferredToBalance = true;
                  delete transaction.metadata.pendingReason;
                  console.log('Retry successful, funds transferred:', { reference: transaction.reference, amount: transaction.amount });

                  await Notification.create([{
                    userId: wallet.userId,
                    title: 'Transaction Completed',
                    message: `Transaction of ₦${transaction.amount.toFixed(2)} completed after retry. Ref: ${transaction.reference}`,
                    transactionId: transaction.reference,
                    type: transaction.type,
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
                      title: 'Transaction Failed',
                      message: `Transaction of ₦${transaction.amount.toFixed(2)} failed after retries. Ref: ${transaction.reference}`,
                      transactionId: transaction.reference,
                      type: transaction.type,
                      status: 'failed',
                      createdAt: new Date(),
                    }], { session });
                  }
                }
              } else {
                // For deposits, complete the transaction if balance check is bypassed or funds are confirmed
                if (process.env.BYPASS_PAYSTACK_BALANCE_CHECK === 'true') {
                  transaction.status = 'completed';
                  wallet.balance += transaction.amount;
                  wallet.totalDeposits += transaction.amount;
                  delete transaction.metadata.pendingReason;
                  console.log('Deposit completed (balance check bypassed):', { reference: transaction.reference, amount: transaction.amount });

                  await Notification.create([{
                    userId: wallet.userId,
                    title: 'Wallet Funded',
                    message: `Wallet funded with ₦${transaction.amount.toFixed(2)} after retry. Ref: ${transaction.reference}`,
                    transactionId: transaction.reference,
                    type: 'funding',
                    status: 'completed',
                    createdAt: new Date(),
                  }], { session });
                } else {
                  try {
                    const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                      timeout: 10000,
                    });

                    if (!balanceResponse.data.status) {
                      throw new Error('Failed to fetch Paystack balance');
                    }

                    const availableBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100;
                    if (availableBalance >= transaction.amount) {
                      transaction.status = 'completed';
                      wallet.balance += transaction.amount;
                      wallet.totalDeposits += transaction.amount;
                      delete transaction.metadata.pendingReason;
                      console.log('Deposit completed after retry:', { reference: transaction.reference, amount: transaction.amount });

                      await Notification.create([{
                        userId: wallet.userId,
                        title: 'Wallet Funded',
                        message: `Wallet funded with ₦${transaction.amount.toFixed(2)} after retry. Ref: ${transaction.reference}`,
                        transactionId: transaction.reference,
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
                          transactionId: transaction.reference,
                          type: 'funding',
                          status: 'failed',
                          createdAt: new Date(),
                        }], { session });
                      }
                    }
                  } catch (balanceError) {
                    console.error('Paystack balance check error during retry:', {
                      message: balanceError.message,
                      status: balanceError.response?.status,
                      response: balanceError.response?.data,
                    });
                    transaction.metadata.retryAttempts = (transaction.metadata.retryAttempts || 0) + 1;
                    if (transaction.metadata.retryAttempts >= 3) {
                      transaction.status = 'failed';
                      transaction.metadata.transferError = balanceError.message;
                      await Notification.create([{
                        userId: wallet.userId,
                        title: 'Funding Failed',
                        message: `Funding of ₦${transaction.amount.toFixed(2)} failed after retries. Ref: ${transaction.reference}`,
                        transactionId: transaction.reference,
                        type: 'funding',
                        status: 'failed',
                        createdAt: new Date(),
                      }], { session });
                    }
                    continue; // Skip to next transaction
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
                  transactionId: transaction.reference,
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

exports.syncWalletBalance = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        return res.status(404).json({ success: false, error: 'Wallet not found' });
      }

      const oldBalance = wallet.balance;
      try {
        await wallet.syncBalanceWithPaystack();
        await wallet.save({ session });

        res.status(200).json({
          success: true,
          message: 'Balance synchronized',
          data: {
            balance: wallet.balance,
            oldBalance: oldBalance,
            newBalance: wallet.balance,
            totalDeposits: wallet.totalDeposits,
            currency: wallet.currency,
            walletId: wallet._id,
            virtualAccount: wallet.virtualAccount,
            lastSynced: wallet.lastSynced.toISOString(),
          },
        });
      } catch (error) {
        console.error('Manual sync error:', {
          userId: req.user.id,
          message: error.message,
          status: error.response?.status,
          response: error.response?.data,
        });
        await Notification.create([{
          userId: req.user.id,
          title: 'Manual Balance Sync Failed',
          message: `Failed to sync wallet balance: ${error.message}`,
          type: 'system',
          status: 'failed',
          createdAt: new Date(),
        }], { session });
        throw error;
      }
    });
  } catch (error) {
    console.error('Manual sync error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to sync balance' });
  } finally {
    session.endSession();
  }
};

exports.syncAllWalletBalances = async () => {
  try {
    const wallets = await Wallet.find({});
    console.log(`Found ${wallets.length} wallets for balance sync`);
    for (const wallet of wallets) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          try {
            await wallet.syncBalanceWithPaystack();
            await wallet.save({ session });
            console.log(`Synced wallet for user ${wallet.userId}`);
          } catch (error) {
            console.error(`Failed to sync wallet ${wallet._id}:`, {
              userId: wallet.userId.toString(),
              message: error.message,
              status: error.response?.status,
              response: error.response?.data,
            });
            if (error.response?.status === 401) {
              await Notification.create([{
                userId: null, // Admin notification
                title: 'Paystack API Key Error',
                message: `Failed to sync wallet ${wallet._id} due to invalid Paystack API key. Please update PAYSTACK_LIVE_SECRET_KEY.`,
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }
            // Skip to next wallet instead of failing entire job
          }
        });
      } finally {
        session.endSession();
      }
    }
    console.log('Batch sync completed');
  } catch (error) {
    console.error('Batch sync error:', error.message);
  }
};

exports.manualReconcileTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { reference } = req.body;
      const userId = req.user.id;
      if (!reference) {
        console.warn('No reference provided for manual reconciliation', { userId });
        return res.status(400).json({ success: false, error: 'Reference is required' });
      }

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        console.warn('Wallet not found, recreating:', { userId });
        wallet = new Wallet({
          userId,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
        });
        await wallet.save({ session });
        console.log('Wallet recreated:', { userId, walletId: wallet._id });
      }

      let transaction = wallet.transactions.find(
        t => t.reference === reference || t.paystackReference === reference
      );

      if (!transaction) {
        console.log('Transaction not found locally, checking Paystack:', { reference, userId });
        try {
          const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
              timeout: 15000,
            }
          );

          if (paystackResponse.data.status && paystackResponse.data.data?.status === 'success') {
            const { amount, reference: paystackReference, customer } = paystackResponse.data.data;
            const amountInNaira = parseFloat(amount) / 100;

            // Search for a matching pending transaction by amount and email
            transaction = wallet.transactions.find(
              t =>
                t.type === 'deposit' &&
                t.status === 'pending' &&
                t.amount === amountInNaira &&
                t.metadata?.customerEmail === customer.email
            );

            if (!transaction) {
              console.log('Creating new transaction for Paystack reference:', { reference, userId });
              transaction = {
                type: 'deposit',
                amount: amountInNaira,
                reference: `FUND_${userId}_${uuidv4()}`,
                paystackReference: paystackReference,
                status: 'completed',
                metadata: {
                  paymentGateway: 'Paystack',
                  customerEmail: customer.email,
                  virtualAccount: wallet.virtualAccount,
                  reconciledManually: true,
                  reconciledAt: new Date(),
                },
                createdAt: new Date(),
              };
              wallet.transactions.push(transaction);
            } else {
              console.log('Updating existing transaction with Paystack reference:', {
                localReference: transaction.reference,
                paystackReference,
                userId,
              });
              transaction.status = 'completed';
              transaction.paystackReference = paystackReference;
              transaction.metadata.reconciledManually = true;
              transaction.metadata.reconciledAt = new Date();
            }

            // Verify Paystack balance
            if (process.env.BYPASS_PAYSTACK_BALANCE_CHECK !== 'true') {
              try {
                const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                  timeout: 10000,
                });

                if (!balanceResponse.data.status) {
                  throw new Error('Failed to fetch Paystack balance');
                }

                const availableBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100;
                if (availableBalance < amountInNaira) {
                  console.warn('Insufficient Paystack balance during reconciliation:', {
                    availableBalance,
                    required: amountInNaira,
                    reference,
                    userId,
                  });
                  transaction.status = 'pending';
                  transaction.metadata.pendingReason = 'Insufficient Paystack balance, awaiting retry';
                  await Notification.create([{
                    userId,
                    title: 'Funding Pending',
                    message: `Funding of ₦${amountInNaira.toFixed(2)} is pending due to insufficient Paystack balance. Ref: ${transaction.reference}`,
                    transactionId: transaction.reference,
                    type: 'funding',
                    status: 'pending',
                    createdAt: new Date(),
                  }], { session });
                  wallet.markModified('transactions');
                  await wallet.save({ session });
                  return res.status(200).json({
                    success: true,
                    message: 'Transaction pending due to insufficient Paystack balance',
                    data: { transaction, newBalance: wallet.balance },
                  });
                }
              } catch (balanceError) {
                console.error('Paystack balance check error during reconciliation:', {
                  message: balanceError.message,
                  status: balanceError.response?.status,
                  response: balanceError.response?.data,
                  reference,
                  userId,
                });
                transaction.status = 'pending';
                transaction.metadata.pendingReason = 'Balance check failed, awaiting retry';
                await Notification.create([{
                  userId,
                  title: 'Funding Pending',
                  message: `Funding of ₦${amountInNaira.toFixed(2)} is pending due to a system issue. Ref: ${transaction.reference}`,
                  transactionId: transaction.reference,
                  type: 'funding',
                  status: 'pending',
                  createdAt: new Date(),
                }], { session });
                wallet.markModified('transactions');
                await wallet.save({ session });
                return res.status(200).json({
                  success: true,
                  message: 'Transaction pending due to system issue',
                  data: { transaction, newBalance: wallet.balance },
                });
              }
            }

            wallet.balance += amountInNaira;
            wallet.totalDeposits += amountInNaira;
            wallet.markModified('transactions');
            await wallet.save({ session });

            await Notification.create([{
              userId,
              title: 'Funding Confirmed',
              message: `Funding of ₦${amountInNaira.toFixed(2)} confirmed. Ref: ${transaction.reference}`,
              transactionId: transaction.reference,
              type: 'funding',
              status: 'completed',
              createdAt: new Date(),
            }], { session });

            // Clear cache
            const cacheKey = `wallet_balance_${userId}`;
            cache.del(cacheKey);
            console.log('Cache cleared for wallet:', { cacheKey, userId, time: new Date().toISOString() });

            const io = req.app.get('io');
            if (io) {
              const retryEmit = async (attempts = 10, delay = 3000) => {
                for (let i = 0; i < attempts; i++) {
                  try {
                    const socketsInRoom = await io.in(userId.toString()).allSockets();
                    if (socketsInRoom.size > 0) {
                      io.to(userId.toString()).emit('balanceUpdate', {
                        balance: wallet.balance,
                        totalDeposits: wallet.totalDeposits,
                        transaction: {
                          amount: amountInNaira,
                          reference: transaction.reference,
                          status: 'completed',
                          paystackReference,
                        },
                      });
                      console.log('Balance update emitted:', {
                        userId,
                        balance: wallet.balance,
                        reference: transaction.reference,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                      return true;
                    } else {
                      console.warn('No active sockets for user:', {
                        userId,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                    }
                  } catch (error) {
                    console.error('Error emitting balance update:', {
                      userId,
                      attempt: i + 1,
                      error: error.message,
                      time: new Date().toISOString(),
                    });
                  }
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
                return false;
              };

              const emitted = await retryEmit();
              if (!emitted) {
                console.warn('Failed to emit balance update after retries:', {
                  userId,
                  time: new Date().toISOString(),
                });
                await Notification.create([{
                  userId,
                  title: 'Balance Update Issue',
                  message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                  type: 'system',
                  status: 'error',
                  createdAt: new Date(),
                }], { session });
              }
            } else {
              console.error('Socket.io instance not available', { time: new Date().toISOString() });
              await Notification.create([{
                userId,
                title: 'Balance Update Issue',
                message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }

            return res.status(200).json({
              success: true,
              message: 'Transaction reconciled successfully',
              data: {
                transaction: {
                  amount: amountInNaira,
                  reference: transaction.reference,
                  status: 'completed',
                  paystackReference,
                },
                newBalance: wallet.balance,
                lastSynced: new Date().toISOString(),
              },
            });
          } else {
            console.log('Paystack verification failed or pending:', {
              reference,
              userId,
              paystackStatus: paystackResponse.data.data?.status,
            });
            return res.status(400).json({
              success: false,
              error: 'Transaction not successful on payment provider',
              data: { status: paystackResponse.data.data?.status || 'pending' },
            });
          }
        } catch (error) {
          console.error('Paystack verification error:', {
            userId,
            reference,
            message: error.message,
            status: error.response?.status,
            response: error.response?.data,
          });
          if (error.response?.status === 400 && error.response?.data?.code === 'transaction_not_found') {
            await Notification.create([{
              userId,
              title: 'Reconciliation Failed',
              message: `Transaction reference ${reference} not found on Paystack. Please verify the reference or contact support.`,
              transactionId: reference,
              type: 'funding',
              status: 'failed',
              createdAt: new Date(),
            }], { session });
            return res.status(404).json({
              success: false,
              error: 'Transaction not found on Paystack',
              details: 'Please verify the transaction reference or contact support.',
            });
          }
          throw error;
        }
      } else if (transaction.status !== 'pending') {
        console.log('Transaction already processed:', { reference, status: transaction.status, userId });
        return res.status(400).json({
          success: false,
          error: 'Transaction is not pending',
          data: { status: transaction.status },
        });
      }

      // Verify existing transaction
      if (transaction.paystackReference) {
        try {
          const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${transaction.paystackReference}`,
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
              timeout: 15000,
            }
          );

          if (paystackResponse.data.status && paystackResponse.data.data?.status === 'success') {
            const amountInNaira = parseFloat(paystackResponse.data.data.amount) / 100;

            // Verify Paystack balance
            if (process.env.BYPASS_PAYSTACK_BALANCE_CHECK !== 'true') {
              try {
                const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                  timeout: 10000,
                });

                if (!balanceResponse.data.status) {
                  throw new Error('Failed to fetch Paystack balance');
                }

                const availableBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100;
                if (availableBalance < amountInNaira) {
                  console.warn('Insufficient Paystack balance during reconciliation:', {
                    availableBalance,
                    required: amountInNaira,
                    reference: transaction.paystackReference,
                    userId,
                  });
                  transaction.metadata.pendingReason = 'Insufficient Paystack balance, awaiting retry';
                  wallet.markModified('transactions');
                  await wallet.save({ session });
                  return res.status(200).json({
                    success: true,
                    message: 'Transaction pending due to insufficient Paystack balance',
                    data: { transaction, newBalance: wallet.balance },
                  });
                }
              } catch (balanceError) {
                console.error('Paystack balance check error during reconciliation:', {
                  message: balanceError.message,
                  status: balanceError.response?.status,
                  response: balanceError.response?.data,
                  reference: transaction.paystackReference,
                  userId,
                });
                transaction.metadata.pendingReason = 'Balance check failed, awaiting retry';
                wallet.markModified('transactions');
                await wallet.save({ session });
                return res.status(200).json({
                  success: true,
                  message: 'Transaction pending due to system issue',
                  data: { transaction, newBalance: wallet.balance },
                });
              }
            }

            transaction.status = 'completed';
            transaction.metadata.reconciledManually = true;
            transaction.metadata.reconciledAt = new Date();
            wallet.balance += amountInNaira;
            wallet.totalDeposits += amountInNaira;
            wallet.markModified('transactions');
            await wallet.save({ session });

            await Notification.create([{
              userId,
              title: 'Funding Confirmed',
              message: `Funding of ₦${amountInNaira.toFixed(2)} confirmed. Ref: ${transaction.reference}`,
              transactionId: transaction.reference,
              type: 'funding',
              status: 'completed',
              createdAt: new Date(),
            }], { session });

            // Clear cache
            const cacheKey = `wallet_balance_${userId}`;
            cache.del(cacheKey);
            console.log('Cache cleared for wallet:', { cacheKey, userId, time: new Date().toISOString() });

            const io = req.app.get('io');
            if (io) {
              const retryEmit = async (attempts = 10, delay = 3000) => {
                for (let i = 0; i < attempts; i++) {
                  try {
                    const socketsInRoom = await io.in(userId.toString()).allSockets();
                    if (socketsInRoom.size > 0) {
                      io.to(userId.toString()).emit('balanceUpdate', {
                        balance: wallet.balance,
                        totalDeposits: wallet.totalDeposits,
                        transaction: {
                          amount: amountInNaira,
                          reference: transaction.reference,
                          status: 'completed',
                          paystackReference: transaction.paystackReference,
                        },
                      });
                      console.log('Balance update emitted:', {
                        userId,
                        balance: wallet.balance,
                        reference: transaction.reference,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                      return true;
                    } else {
                      console.warn('No active sockets for user:', {
                        userId,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                    }
                  } catch (error) {
                    console.error('Error emitting balance update:', {
                      userId,
                      attempt: i + 1,
                      error: error.message,
                      time: new Date().toISOString(),
                    });
                  }
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
                return false;
              };

              const emitted = await retryEmit();
              if (!emitted) {
                console.warn('Failed to emit balance update after retries:', {
                  userId,
                  time: new Date().toISOString(),
                });
                await Notification.create([{
                  userId,
                  title: 'Balance Update Issue',
                  message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                  type: 'system',
                  status: 'error',
                  createdAt: new Date(),
                }], { session });
              }
            } else {
              console.error('Socket.io instance not available', { time: new Date().toISOString() });
              await Notification.create([{
                userId,
                title: 'Balance Update Issue',
                message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }

            return res.status(200).json({
              success: true,
              message: 'Transaction reconciled successfully',
              data: {
                transaction: {
                  amount: amountInNaira,
                  reference: transaction.reference,
                  status: 'completed',
                  paystackReference: transaction.paystackReference,
                },
                newBalance: wallet.balance,
                lastSynced: new Date().toISOString(),
              },
            });
          } else {
            console.log('Paystack verification failed or pending:', {
              reference: transaction.paystackReference,
              userId,
              paystackStatus: paystackResponse.data.data?.status,
            });
            return res.status(400).json({
              success: false,
              error: 'Transaction not successful on payment provider',
              data: { status: paystackResponse.data.data?.status || 'pending' },
            });
          }
        } catch (error) {
          console.error('Paystack verification error:', {
            userId,
            reference: transaction.paystackReference,
            message: error.message,
            status: error.response?.status,
            response: error.response?.data,
          });
          if (error.response?.status === 400 && error.response?.data?.code === 'transaction_not_found') {
            await Notification.create([{
              userId,
              title: 'Reconciliation Failed',
              message: `Transaction reference ${transaction.paystackReference} not found on Paystack. Please contact support.`,
              transactionId: transaction.reference,
              type: 'funding',
              status: 'failed',
              createdAt: new Date(),
            }], { session });
            return res.status(404).json({
              success: false,
              error: 'Transaction not found on Paystack',
              details: 'Please contact support to verify the transaction.',
            });
          }
          throw error;
        }
      }

      return res.status(400).json({
        success: false,
        error: 'Invalid or non-pending transaction',
      });
    });
  } catch (error) {
    console.error('Manual reconcile error:', {
      userId: req.user?.id,
      reference: req.body.reference,
      message: error.message,
      status: error.response?.status,
      response: error.response?.data,
    });
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to reconcile transaction',
    });
  } finally {
    session.endSession();
  }
};

exports.checkFundingStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { reference } = req.params;
      const userId = req.user.id;
      if (!reference) {
        console.warn('No reference provided for funding status check', { userId });
        return res.status(400).json({ success: false, error: 'Reference is required' });
      }

      console.log('Checking funding status:', { reference, userId });

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        console.warn('Wallet not found, recreating:', { userId });
        wallet = new Wallet({
          userId,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
          lastSynced: new Date(),
        });
        await wallet.save({ session });
        console.log('Wallet recreated:', { userId, walletId: wallet._id });
      }

      let transaction = wallet.transactions.find(
        t => t.reference === reference || t.paystackReference === reference
      );

      if (!transaction) {
        console.log('Transaction not found locally, checking Paystack:', { reference, userId });
        try {
          const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
              timeout: 15000,
            }
          );

          if (paystackResponse.data.status && paystackResponse.data.data?.status === 'success') {
            const { amount, reference: paystackReference, customer } = paystackResponse.data.data;
            const amountInNaira = parseFloat(amount) / 100;

            // Search for a matching pending transaction by amount and email
            transaction = wallet.transactions.find(
              t =>
                t.type === 'deposit' &&
                t.status === 'pending' &&
                t.amount === amountInNaira &&
                t.metadata?.customerEmail === customer.email
            );

            if (!transaction) {
              console.log('Creating new transaction for Paystack reference:', { reference, userId });
              transaction = {
                type: 'deposit',
                amount: amountInNaira,
                reference: `FUND_${userId}_${uuidv4()}`,
                paystackReference: paystackReference,
                status: 'completed',
                metadata: {
                  paymentGateway: 'Paystack',
                  customerEmail: customer.email,
                  virtualAccount: wallet.virtualAccount,
                  reconciledManually: true,
                  reconciledAt: new Date(),
                },
                createdAt: new Date(),
              };
              wallet.transactions.push(transaction);
            } else {
              console.log('Updating existing transaction with Paystack reference:', {
                localReference: transaction.reference,
                paystackReference,
                userId,
              });
              transaction.status = 'completed';
              transaction.paystackReference = paystackReference;
              transaction.metadata.reconciledManually = true;
              transaction.metadata.reconciledAt = new Date();
            }

            // Verify Paystack balance
            if (process.env.BYPASS_PAYSTACK_BALANCE_CHECK !== 'true') {
              try {
                const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                  timeout: 10000,
                });

                if (!balanceResponse.data.status) {
                  throw new Error('Failed to fetch Paystack balance');
                }

                const availableBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100;
                if (availableBalance < amountInNaira) {
                  console.warn('Insufficient Paystack balance during funding check:', {
                    availableBalance,
                    required: amountInNaira,
                    reference,
                    userId,
                  });
                  transaction.status = 'pending';
                  transaction.metadata.pendingReason = 'Insufficient Paystack balance, awaiting retry';
                  await Notification.create([{
                    userId,
                    title: 'Funding Pending',
                    message: `Funding of ₦${amountInNaira.toFixed(2)} is pending due to insufficient Paystack balance. Ref: ${transaction.reference}`,
                    transactionId: transaction.reference,
                    type: 'funding',
                    status: 'pending',
                    createdAt: new Date(),
                  }], { session });
                  wallet.markModified('transactions');
                  await wallet.save({ session });
                  return res.status(200).json({
                    success: true,
                    message: 'Transaction pending due to insufficient Paystack balance',
                    data: { transaction, newBalance: wallet.balance, lastSynced: new Date().toISOString() },
                  });
                }
              } catch (balanceError) {
                console.error('Paystack balance check error during funding check:', {
                  message: balanceError.message,
                  status: balanceError.response?.status,
                  response: balanceError.response?.data,
                  reference,
                  userId,
                });
                transaction.status = 'pending';
                transaction.metadata.pendingReason = 'Balance check failed, awaiting retry';
                await Notification.create([{
                  userId,
                  title: 'Funding Pending',
                  message: `Funding of ₦${amountInNaira.toFixed(2)} is pending due to a system issue. Ref: ${transaction.reference}`,
                  transactionId: transaction.reference,
                  type: 'funding',
                  status: 'pending',
                  createdAt: new Date(),
                }], { session });
                wallet.markModified('transactions');
                await wallet.save({ session });
                return res.status(200).json({
                  success: true,
                  message: 'Transaction pending due to system issue',
                  data: { transaction, newBalance: wallet.balance, lastSynced: new Date().toISOString() },
                });
              }
            }

            wallet.balance += amountInNaira;
            wallet.totalDeposits += amountInNaira;
            wallet.markModified('transactions');
            await wallet.save({ session });

            await Notification.create([{
              userId,
              title: 'Wallet Funded Successfully',
              message: `Your wallet has been funded with ₦${amountInNaira.toFixed(2)} NGN. Reference: ${transaction.reference}.`,
              transactionId: transaction.reference,
              type: 'funding',
              status: 'completed',
              createdAt: new Date(),
            }], { session });

            // Clear cache
            const cacheKey = `wallet_balance_${userId}`;
            cache.del(cacheKey);
            console.log('Cache cleared for wallet:', { cacheKey, userId, time: new Date().toISOString() });

            const io = req.app.get('io');
            if (io) {
              const retryEmit = async (attempts = 10, delay = 3000) => {
                for (let i = 0; i < attempts; i++) {
                  try {
                    const socketsInRoom = await io.in(userId.toString()).allSockets();
                    if (socketsInRoom.size > 0) {
                      io.to(userId.toString()).emit('balanceUpdate', {
                        balance: wallet.balance,
                        totalDeposits: wallet.totalDeposits,
                        transaction: {
                          amount: amountInNaira,
                          reference: transaction.reference,
                          status: 'completed',
                          paystackReference,
                        },
                      });
                      console.log('Balance update emitted:', {
                        userId,
                        balance: wallet.balance,
                        reference: transaction.reference,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                      return true;
                    } else {
                      console.warn('No active sockets for user:', {
                        userId,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                    }
                  } catch (error) {
                    console.error('Error emitting balance update:', {
                      userId,
                      attempt: i + 1,
                      error: error.message,
                      time: new Date().toISOString(),
                    });
                  }
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
                return false;
              };

              const emitted = await retryEmit();
              if (!emitted) {
                console.warn('Failed to emit balance update after retries:', {
                  userId,
                  time: new Date().toISOString(),
                });
                await Notification.create([{
                  userId,
                  title: 'Balance Update Issue',
                  message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                  type: 'system',
                  status: 'error',
                  createdAt: new Date(),
                }], { session });
              }
            } else {
              console.error('Socket.io instance not available', { time: new Date().toISOString() });
              await Notification.create([{
                userId,
                title: 'Balance Update Issue',
                message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }

            return res.status(200).json({
              success: true,
              message: 'Payment confirmed',
              data: {
                transaction,
                newBalance: wallet.balance,
                lastSynced: new Date().toISOString(),
              },
            });
          } else {
            console.log('Paystack verification pending:', {
              reference,
              userId,
              paystackStatus: paystackResponse.data.data?.status,
            });
            await wallet.save({ session });
            return res.status(200).json({
              success: true,
              message: 'Payment not confirmed',
              data: {
                status: paystackResponse.data.data?.status || 'pending',
                newBalance: wallet.balance,
                lastSynced: new Date().toISOString(),
              },
            });
          }
        } catch (error) {
          console.error('Paystack verification error:', {
            reference,
            userId,
            message: error.message,
            status: error.response?.status,
            response: error.response?.data,
          });
          if (error.response?.status === 400 && error.response?.data?.code === 'transaction_not_found') {
            await Notification.create([{
              userId,
              title: 'Funding Verification Failed',
              message: `Transaction reference ${reference} not found on Paystack. Please verify the reference or contact support.`,
              transactionId: reference,
              type: 'funding',
              status: 'failed',
              createdAt: new Date(),
            }], { session });
            return res.status(404).json({
              success: false,
              error: 'Transaction not found on Paystack',
              details: 'Please verify the transaction reference or contact support.',
            });
          }
          throw error;
        }
      }

      console.log('Transaction status:', {
        reference,
        status: transaction.status,
        amount: transaction.amount,
        balance: wallet.balance,
        paystackReference: transaction.paystackReference,
        userId,
      });

      if (transaction.status === 'pending' && transaction.paystackReference) {
        try {
          const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${transaction.paystackReference}`,
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
              timeout: 15000,
            }
          );

          if (paystackResponse.data.status && paystackResponse.data.data?.status === 'success') {
            const amountInNaira = parseFloat(paystackResponse.data.data.amount) / 100;

            // Verify Paystack balance
            if (process.env.BYPASS_PAYSTACK_BALANCE_CHECK !== 'true') {
              try {
                const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                  timeout: 10000,
                });

                if (!balanceResponse.data.status) {
                  throw new Error('Failed to fetch Paystack balance');
                }

                const availableBalance = balanceResponse.data.data.find(b => b.currency === 'NGN')?.balance / 100;
                if (availableBalance < amountInNaira) {
                  console.warn('Insufficient Paystack balance during funding check:', {
                    availableBalance,
                    required: amountInNaira,
                    reference: transaction.paystackReference,
                    userId,
                  });
                  transaction.metadata.pendingReason = 'Insufficient Paystack balance, awaiting retry';
                  wallet.markModified('transactions');
                  await wallet.save({ session });
                  return res.status(200).json({
                    success: true,
                    message: 'Transaction pending due to insufficient Paystack balance',
                    data: { transaction, newBalance: wallet.balance, lastSynced: new Date().toISOString() },
                  });
                }
              } catch (balanceError) {
                console.error('Paystack balance check error during funding check:', {
                  message: balanceError.message,
                  status: balanceError.response?.status,
                  response: balanceError.response?.data,
                  reference: transaction.paystackReference,
                  userId,
                });
                transaction.metadata.pendingReason = 'Balance check failed, awaiting retry';
                wallet.markModified('transactions');
                await wallet.save({ session });
                return res.status(200).json({
                  success: true,
                  message: 'Transaction pending due to system issue',
                  data: { transaction, newBalance: wallet.balance, lastSynced: new Date().toISOString() },
                });
              }
            }

            transaction.status = 'completed';
            transaction.metadata.reconciledManually = true;
            transaction.metadata.reconciledAt = new Date();
            wallet.balance += amountInNaira;
            wallet.totalDeposits += amountInNaira;
            wallet.markModified('transactions');
            await wallet.save({ session });

            await Notification.create([{
              userId,
              title: 'Wallet Funded Successfully',
              message: `Your wallet has been funded with ₦${amountInNaira.toFixed(2)} NGN. Reference: ${transaction.reference}.`,
              transactionId: transaction.reference,
              type: 'funding',
              status: 'completed',
              createdAt: new Date(),
            }], { session });

            // Clear cache
            const cacheKey = `wallet_balance_${userId}`;
            cache.del(cacheKey);
            console.log('Cache cleared for wallet:', { cacheKey, userId, time: new Date().toISOString() });

            const io = req.app.get('io');
            if (io) {
              const retryEmit = async (attempts = 10, delay = 3000) => {
                for (let i = 0; i < attempts; i++) {
                  try {
                    const socketsInRoom = await io.in(userId.toString()).allSockets();
                    if (socketsInRoom.size > 0) {
                      io.to(userId.toString()).emit('balanceUpdate', {
                        balance: wallet.balance,
                        totalDeposits: wallet.totalDeposits,
                        transaction: {
                          amount: amountInNaira,
                          reference: transaction.reference,
                          status: 'completed',
                          paystackReference: transaction.paystackReference,
                        },
                      });
                      console.log('Balance update emitted:', {
                        userId,
                        balance: wallet.balance,
                        reference: transaction.reference,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                      return true;
                    } else {
                      console.warn('No active sockets for user:', {
                        userId,
                        attempt: i + 1,
                        time: new Date().toISOString(),
                      });
                    }
                  } catch (error) {
                    console.error('Error emitting balance update:', {
                      userId,
                      attempt: i + 1,
                      error: error.message,
                      time: new Date().toISOString(),
                    });
                  }
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
                return false;
              };

              const emitted = await retryEmit();
              if (!emitted) {
                console.warn('Failed to emit balance update after retries:', {
                  userId,
                  time: new Date().toISOString(),
                });
                await Notification.create([{
                  userId,
                  title: 'Balance Update Issue',
                  message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                  type: 'system',
                  status: 'error',
                  createdAt: new Date(),
                }], { session });
              }
            } else {
              console.error('Socket.io instance not available', { time: new Date().toISOString() });
              await Notification.create([{
                userId,
                title: 'Balance Update Issue',
                message: 'Wallet balance updated, but real-time update failed. Please refresh to see the latest balance.',
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }

            return res.status(200).json({
              success: true,
              message: 'Payment confirmed',
              data: {
                transaction,
                newBalance: wallet.balance,
                lastSynced: new Date().toISOString(),
              },
            });
          } else {
            console.log('Paystack verification failed or pending:', {
              reference: transaction.paystackReference,
              userId,
              paystackStatus: paystackResponse.data.data?.status,
            });
            return res.status(200).json({
              success: true,
              message: 'Payment not confirmed',
              data: {
                status: paystackResponse.data.data?.status || 'pending',
                newBalance: wallet.balance,
                lastSynced: new Date().toISOString(),
              },
            });
          }
        } catch (error) {
          console.error('Paystack verification error:', {
            reference: transaction.paystackReference,
            userId,
            message: error.message,
            status: error.response?.status,
            response: error.response?.data,
          });
          if (error.response?.status === 400 && error.response?.data?.code === 'transaction_not_found') {
            await Notification.create([{
              userId,
              title: 'Funding Verification Failed',
              message: `Transaction reference ${transaction.paystackReference} not found on Paystack. Please contact support.`,
              transactionId: transaction.reference,
              type: 'funding',
              status: 'failed',
              createdAt: new Date(),
            }], { session });
            return res.status(404).json({
              success: false,
              error: 'Transaction not found on Paystack',
              details: 'Please contact support to verify the transaction.',
            });
          }
          throw error;
        }
      }

      return res.status(200).json({
        success: true,
        message: `Transaction status: ${transaction.status}`,
        data: {
          transaction,
          newBalance: wallet.balance,
          lastSynced: new Date().toISOString(),
        },
      });
    });
  } catch (error) {
    console.error('Funding status check error:', {
      userId: req.user?.id,
      reference: req.params.reference,
      message: error.message,
      status: error.response?.status,
      response: error.response?.data,
    });
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to check funding status',
    });
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

      const timeoutThreshold = 24 * 60 * 60 * 1000; // 24 hours

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
              transactionId: tx.reference,
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
                transactionId: tx.reference,
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
                transactionId: tx.reference,
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
                transactionId: tx.reference,
                type: 'system',
                status: 'error',
                createdAt: new Date(),
              }], { session });
            }
            continue;
          }
        }

        try {
          await wallet.syncBalanceWithPaystack();
          await wallet.save({ session });
          console.log('Wallet synced and saved:', { userId: wallet.userId, newBalance: wallet.balance });
        } catch (error) {
          console.error('Sync error during reconciliation:', {
            userId: wallet.userId,
            message: error.message,
            status: error.response?.status,
            response: error.response?.data,
          });
          continue;
        }

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

// Enhanced bank code validation
const validateBankCode = (bankCode) => {
  const isValidFormat = /^\d{3,6}$/.test(bankCode);
  const isKnownBank = CRITICAL_BANKS.some(bank => bank.code === bankCode);

  return {
    isValid: isValidFormat,
    isKnown: isKnownBank,
    suggestion: isKnownBank ? null : CRITICAL_BANKS.find(bank =>
      bank.name.toLowerCase().includes('opay') ||
      bank.name.toLowerCase().includes('palmpay')
    )
  };
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

exports.withdrawFunds = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, bankCode, accountNumber, accountName } = req.body;
      const userId = req.user.id;
      const amountNum = parseFloat(amount);

      if (!amountNum || amountNum <= 0 || amountNum < 100 || !bankCode || !accountNumber || !accountName) {
        return res.status(400).json({ success: false, error: 'Invalid input' });
      }

      if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({ success: false, error: 'Invalid account number' });
      }

      const wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        return res.status(404).json({ success: false, error: 'Wallet not found' });
      }

      await wallet.validateWithdrawal(amountNum);

      // Check Paystack Transfer Balance
      const balanceResponse = await axios.get('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      if (!balanceResponse.data?.status) {
        throw new Error('Failed to check Paystack balance');
      }

      const transferBalance = balanceResponse.data.data.find(b => b.balance_type === 'transfers')?.balance / 100 || 0;
      if (transferBalance < amountNum) {
        try {
          await transferToPaystackTransferBalance(amountNum, `Fund withdrawal for user ${userId}`);
        } catch (transferError) {
          console.error('Transfer balance top-up failed:', transferError.message);
          return res.status(502).json({
            success: false,
            error: 'Insufficient funds in payment gateway. Please contact support.',
          });
        }
      }

      const headers = { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' };
      const verifyResponse = await axios.get(
        `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        { headers, timeout: 15000 }
      );

      if (!verifyResponse.data?.status) {
        return res.status(400).json({ success: false, error: 'Invalid account details' });
      }

      const recipientResponse = await axios.post(
        'https://api.paystack.co/transferrecipient',
        { type: 'nuban', name: accountName, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' },
        { headers, timeout: 20000 }
      );

      if (!recipientResponse.data?.status) {
        throw new Error('Failed to create recipient');
      }

      const reference = `WD-${crypto.randomBytes(6).toString('hex').toUpperCase()}-${Date.now()}`;
      const transferResponse = await axios.post(
        'https://api.paystack.co/transfer',
        {
          source: 'balance',
          amount: Math.round(amountNum * 100),
          reference,
          recipient: recipientResponse.data.data.recipient_code,
          reason: `Withdrawal - ${reference}`,
        },
        { headers, timeout: 30000 }
      );

      if (!transferResponse.data?.status) {
        throw new Error('Transfer initiation failed');
      }

      wallet.balance -= amountNum;
      wallet.transactions.push({
        type: 'withdrawal',
        amount: amountNum,
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'Paystack',
          bankCode,
          accountNumber,
          accountName,
          transferCode: transferResponse.data.data.transfer_code,
          recipientCode: recipientResponse.data.data.recipient_code,
        },
        createdAt: new Date(),
      });

      await wallet.save({ session });
      await Notification.create([{
        userId,
        title: 'Withdrawal Initiated',
        message: `Withdrawal of ₦${amountNum.toFixed(2)} initiated. Ref: ${reference}`,
        transactionId: reference,
        type: 'withdrawal',
        status: 'pending',
      }], { session });

      const io = req.app.get('io');
      if (io) {
        io.to(userId.toString()).emit('balanceUpdate', {
          balance: wallet.balance,
          transaction: { amount: amountNum, reference, status: 'pending', type: 'withdrawal' },
        });
      }

      res.status(200).json({
        success: true,
        message: 'Withdrawal initiated',
        data: { reference, amount: amountNum, newBalance: wallet.balance, transferCode: transferResponse.data.data.transfer_code },
      });
    });
  } catch (error) {
    console.error('Withdrawal error:', error.message);
    res.status(error.response?.status || 500).json({ success: false, error: 'Failed to process withdrawal' });
  } finally {
    session.endSession();
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

    if (response.data?.status) {
      const balanceData = response.data.data;
      return res.status(200).json({
        success: true,
        data: {
          currency: balanceData.currency,
          transferBalance: balanceData.find(b => b.balance_type === 'transfers')?.balance / 100 || 0,
          revenueBalance: balanceData.find(b => b.balance_type === 'revenue')?.balance / 100 || 0,
          lastUpdated: new Date().toISOString(),
        },
      });
    } else {
      throw new Error('Invalid response from Paystack');
    }
  } catch (error) {
    console.error('Failed to check Paystack balance:', error.message);
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
        transactionId: reference,
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
  try {
    console.log('Fetching wallet transactions for user:', req.user.id);
    let wallet = await Wallet.findOne({ userId: req.user.id });

    if (!wallet) {
      console.warn('Wallet not found for user, recreating:', req.user.id);
      const user = await User.findById(req.user.id);
      if (!user) {
        console.error('User not found during wallet recreation:', req.user.id);
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      wallet = new Wallet({
        userId: req.user.id,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet recreated for user:', { userId: req.user.id, walletId: wallet._id });
    }

    const transactions = wallet.transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.status(200).json({
      success: true,
      data: {
        transactions,
      },
    });
  } catch (error) {
    console.error('Get transactions error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
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
    const minimumBalance = 100; // Minimum threshold for revenue balance

    if (revenueBalance < minimumBalance) {
      console.warn('Low Paystack revenue balance:', { revenueBalance });
      await Notification.create({
        userId: null, // System-wide notification
        title: 'Low Paystack Revenue Balance',
        message: `Paystack revenue balance is ₦${revenueBalance.toFixed(2)}. Please top up to ensure smooth operations.`,
        type: 'system',
        status: 'warning',
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
      userId: null, // System-wide notification
      title: 'Paystack Balance Check Failure',
      message: `Failed to check Paystack balance: ${error.message}`,
      type: 'system',
      status: 'error',
    });
  }
};