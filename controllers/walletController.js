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
  maxConcurrent: 5, // Reduced to minimize race conditions
  minTime: 200, // Increased delay for better control
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

// Helper function to serialize dates and remove MongoDB circular references
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

// Helper function to serialize user data and remove MongoDB metadata
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

  // Convert Mongoose document to plain object
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

const transferToPaystackTransferBalance = async (amount, reason = 'Fund Transfer Balance', session) => {
  return limiter.schedule(async () => {
    try {
      console.log('Initiating Paystack transfer to transfer balance:', { amount, reason });

      const response = await axios.post(
        'https://api.paystack.co/transfer',
        {
          source: 'balance', // Primary balance (revenue)
          amount: Math.round(amount * 100), // Convert to kobo
          currency: 'NGN',
          reason,
          recipient: 'balance', // Transfer to transfer balance
        },
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      if (!response.data.status) {
        throw new Error(response.data.message || 'Failed to transfer to Paystack transfer balance');
      }

      console.log('Transfer to transfer balance successful:', response.data.data);
      return { status: true, data: response.data.data };
    } catch (error) {
      console.error('Transfer to transfer balance error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });

      await Notification.create(
        {
          userId: null,
          title: 'Transfer Failure',
          message: `Failed to transfer ₦${amount.toFixed(2)} to Paystack transfer balance: ${error.message}`,
          type: 'system',
          status: 'error',
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
        logger.warn('User not found', { userId });
        throw new Error('User not found');
      }

      const balanceResponse = await axios.get('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 10000,
      });

      if (!balanceResponse.data?.status) {
        logger.error('Paystack API key invalid', { response: balanceResponse.data });
        throw new Error('Payment provider configuration issue');
      }

      if (!user.paystackCustomerCode) {
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
          logger.error('Failed to create Paystack customer', { response: customerResponse.data });
          throw new Error('Failed to initialize payment profile');
        }

        user.paystackCustomerCode = customerResponse.data.data.customer_code;
        await user.save({ session });
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
            logger.warn(`Failed to create virtual account with ${bank}`, { error: error.message });
          }
        }

        if (!accountResponse?.data?.status) {
          logger.error('Failed to create virtual account', { userId });
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
    });
    return res.status(500).json({
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
        if (!['dedicatedaccount.credit', 'charge.success'].includes(event)) {
          logger.info('Ignoring non-relevant Paystack event', { event });
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
        let transaction = wallet.transactions.find(
          (t) =>
            t.paystackReference === reference ||
            (t.metadata?.virtualAccountId === account_details?.id && t.status === 'pending') ||
            (t.amount === amountInNaira && t.status === 'pending' && !t.paystackReference)
        );

        if (!transaction) {
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
          transaction.paystackReference = reference;
        }

        if (status === 'success') {
          transaction.status = 'completed';
          wallet.balance += amountInNaira;
          wallet.totalDeposits += amountInNaira;
          logger.info('Wallet funded successfully', {
            amount: amountInNaira,
            reference,
            newBalance: wallet.balance,
          });

          // Transfer funds to Paystack transfer balance
          try {
            const transferResult = await transferToPaystackTransferBalance(
              amountInNaira,
              `Fund Transfer for ${reference}`,
              session
            );
            if (transferResult.status) {
              transaction.metadata.transferredToBalance = true;
              logger.info('Funds transferred to Paystack transfer balance', {
                amount: amountInNaira,
                reference,
              });
            }
          } catch (transferError) {
            logger.error('Failed to transfer to Paystack transfer balance', {
              reference,
              message: transferError.message,
            });
            transaction.metadata.pendingReason = 'Insufficient Paystack balance, awaiting retry';
            transaction.metadata.retryAttempts = (transaction.metadata.retryAttempts || 0) + 1;
          }
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
              amount: amountInNaira,
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
                  ? `Wallet funded with ₦${amountInNaira.toFixed(2)}. Ref: ${transaction.reference}`
                  : `Funding of ₦${amountInNaira.toFixed(2)} failed. Ref: ${transaction.reference}`,
              transactionId: transaction.reference,
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

exports.getWalletBalance = async (req, res) => {
  let session;
  try {
    if (!req.user?.id) {
      logger.error('No user ID in request', { user: req.user });
      return res.status(401).json({ success: false, error: 'Unauthorized: No user ID provided' });
    }

    const { noCache } = req.query;
    const cacheKey = `wallet_balance_${req.user.id}`;
    const useCache = !noCache || noCache === 'false';

    if (useCache) {
      const cachedBalance = cache.get(cacheKey);
      if (cachedBalance) {
        logger.info('Returning cached wallet balance', { userId: req.user.id, cacheKey });
        return res.status(200).json({ success: true, data: cachedBalance, source: 'cache' });
      }
    }

    session = await mongoose.startSession();
    let responseData;

    await session.withTransaction(async () => {
      const user = await User.findById(req.user.id).session(session);
      if (!user) {
        logger.error('User not found', { userId: req.user.id });
        return res.status(404).json({ success: false, error: 'User not found' });
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
        logger.info('Created new wallet', { userId: req.user.id, walletId: wallet._id });
      }

      responseData = {
        user: serializeUserData(user),
        wallet: serializeWalletData(wallet),
      };

      if (useCache) {
        cache.set(cacheKey, responseData);
        logger.info('Cached wallet balance', { userId: req.user.id, cacheKey });
      }

      const io = req.app.get('io');
      if (io) {
        io.to(req.user.id.toString()).emit('balanceUpdate', {
          balance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
          lastSynced: wallet.lastSynced instanceof Date
            ? wallet.lastSynced.toISOString()
            : new Date(wallet.lastSynced).toISOString(),
        });
        logger.info('Balance update emitted', { userId: req.user.id });
      }
    });

    // Ensure session is ended before sending response
    if (session) {
      await session.endSession();
      session = null;
    }

    return res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    logger.error('Get wallet balance error', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
      errorName: error.name,
    });

    if (session) {
      await session.endSession();
    }

    if (error.name === 'MongoServerError') {
      return res.status(503).json({ success: false, error: 'Database error: Unable to fetch wallet data' });
    }
    if (error instanceof TypeError && error.message.includes('Converting circular structure to JSON')) {
      return res.status(500).json({ success: false, error: 'Internal server error: Invalid response data format' });
    }
    return res.status(500).json({ success: false, error: 'Failed to fetch wallet balance' });
  }
};


exports.initiateFunding = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, email, phoneNumber, userId } = req.body;
      const amountNum = parseFloat(amount);

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
        });
      }

      const user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error('User not found');
      }

      let customerCode = user.paystackCustomerCode;
      if (!customerCode) {
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
            timeout: 10000,
          }
        );

        if (!customerResponse.data.status) {
          logger.error('Failed to create Paystack customer', { response: customerResponse.data });
          throw new Error('Failed to create Paystack customer');
        }

        customerCode = customerResponse.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await user.save({ session });
      }

      let virtualAccount = wallet.virtualAccount;
      if (!virtualAccount?.account_number) {
        const banksToTry = process.env.NODE_ENV === 'production'
          ? ['wema-bank', 'access-bank']
          : ['wema-bank'];

        let accountResponse = null;
        for (const bank of banksToTry) {
          try {
            accountResponse = await axios.post(
              'https://api.paystack.co/dedicated_account',
              {
                customer: customerCode,
                preferred_bank: bank,
              },
              {
                headers: { Authorization: `Bearer ${exports.getPaystackSecretKey()}` },
                timeout: 10000,
              }
            );
            if (accountResponse.data.status) break;
          } catch (error) {
            logger.warn(`Failed to create virtual account with ${bank}`, { error: error.message });
          }
        }

        if (!accountResponse?.data?.status) {
          logger.error('Failed to create virtual account', { userId });
          throw new Error('Unable to create virtual account');
        }

        virtualAccount = {
          account_name: accountResponse.data.data.account_name,
          account_number: accountResponse.data.data.account_number,
          bank_name: accountResponse.data.data.bank.name,
          provider: 'Paystack',
          provider_reference: accountResponse.data.data.id,
          created_at: new Date().toISOString(),
          active: true,
        };
        wallet.virtualAccount = virtualAccount;
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
        createdAt: new Date().toISOString(),
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
          createdAt: new Date().toISOString(),
        }],
        { session }
      );

      // Serialize the wallet data to remove Mongoose metadata
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
            step2: 'Your wallet will be credited automatically within 5 minutes',
            step3: 'You will receive a notification once payment is confirmed',
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
          for (const transaction of wallet.transactions.filter(t => t.status === 'pending')) {
            try {
              if (transaction.metadata?.pendingReason === 'Insufficient Paystack balance, awaiting retry') {
                const transferResult = await transferToPaystackTransferBalance(
                  transaction.amount,
                  `Retry for ${transaction.reference}`,
                  session
                );
                if (transferResult.status) {
                  transaction.status = 'completed';
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
              } else if (transaction.type === 'deposit') {
                const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                  timeout: 10000,
                });

                if (!balanceResponse.data.status) {
                  throw new Error('Failed to fetch Paystack balance');
                }

                const availableBalance = balanceResponse.data.data.find(b => b.balance_type === 'transfers')?.balance / 100 || 0;
                if (availableBalance >= transaction.amount) {
                  transaction.status = 'completed';
                  wallet.balance += transaction.amount;
                  wallet.totalDeposits += transaction.amount;
                  transaction.metadata.transferredToBalance = true;
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
      transaction.metadata.reconciledAt = new Date().toISOString(); // Serialize reconciledAt
      wallet.balance += amountInNaira;
      wallet.totalDeposits += amountInNaira;

      wallet.markModified('transactions');
      await wallet.save({ session });

      await Notification.create(
        [{
          userId,
          title: 'Funding Confirmed',
          message: `Funding of ₦${amountInNaira.toFixed(2)} confirmed. Ref: ${reference}`,
          transactionId: reference,
          type: 'funding',
          status: 'completed',
          createdAt: new Date().toISOString(), // Serialize createdAt
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
                reconciledAt: new Date().toISOString(), // Serialize reconciledAt
              },
              createdAt: new Date().toISOString(), // Serialize createdAt
            };
            wallet.transactions.push(transaction);
          } else {
            transaction.status = 'completed';
            transaction.paystackReference = paystackReference;
            transaction.metadata.reconciledManually = true;
            transaction.metadata.reconciledAt = new Date().toISOString(); // Serialize reconciledAt
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
          transaction.metadata.reconciledAt = new Date().toISOString(); // Serialize reconciledAt
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
            transactionId: transaction.reference,
            type: 'funding',
            status: transaction.status,
            createdAt: new Date().toISOString(), // Serialize createdAt
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

exports.withdrawFunds = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, bankCode, accountNumber, accountName } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        logger.error('User ID not found in request', { url: req.originalUrl, headers: req.headers });
        throw new Error('Unauthorized: User ID not found in request');
      }
      if (!amount || amount < 100 || !bankCode || !accountNumber || !accountName) {
        throw new Error('All fields are required. Minimum withdrawal is ₦100.');
      }

      logger.info('Withdraw funds request', { userId, amount, bankCode, accountNumber: accountNumber.slice(-4) });

      const wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      if (wallet.balance < amount) {
        throw new Error(`Insufficient wallet balance. Available: ₦${wallet.balance}, Requested: ₦${amount}`);
      }

      const balanceResponse = await retryAsync(() =>
        axios.get('https://api.paystack.co/balance', {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 10000,
        })
      );
      const availableBalance = balanceResponse.data.data[0].balance / 100;
      const transferFee = amount > 5000 ? 10 + amount * 0.005 : amount > 500 ? 25 : 10;
      const totalAmount = amount + transferFee;

      if (totalAmount > availableBalance) {
        throw new Error(
          `Insufficient Paystack balance. Available: ₦${availableBalance}, Required: ₦${totalAmount} (including ₦${transferFee} fee)`
        );
      }

      const banksResponse = await retryAsync(() =>
        axios.get('https://api.paystack.co/bank', {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 10000,
        })
      );
      const validBank = banksResponse.data.data.find((bank) => bank.code === bankCode);
      if (!validBank) {
        throw new Error(`Invalid bank code: ${bankCode}`);
      }

      const verifyResponse = await retryAsync(() =>
        axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 10000,
        })
      );
      if (!verifyResponse.data.status || verifyResponse.data.data.account_name.toUpperCase() !== accountName.toUpperCase()) {
        throw new Error('Account verification failed or name mismatch');
      }

      let recipientCode;
      try {
        const recipientResponse = await retryAsync(() =>
          axios.post(
            'https://api.paystack.co/transferrecipient',
            {
              type: 'nuban',
              name: accountName,
              account_number: accountNumber,
              bank_code: bankCode,
              currency: 'NGN',
            },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 10000 }
          )
        );
        recipientCode = recipientResponse.data.data.recipient_code;
      } catch (error) {
        throw new Error(`Failed to create transfer recipient: ${error.response?.data?.message || error.message}`);
      }

      const reference = `WDR_${userId}_${Date.now()}_${require('crypto').randomBytes(4).toString('hex')}`;
      const transaction = {
        type: 'withdrawal',
        amount,
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'Paystack',
          bankCode,
          accountNumber: accountNumber.slice(-4),
          accountName,
          recipientCode,
        },
        createdAt: new Date(),
      };
      wallet.transactions.push(transaction);
      wallet.balance -= amount;
      await wallet.save({ session });

      await Notification.create(
        [
          {
            userId,
            title: 'Withdrawal Initiated',
            message: `Withdrawal request of ₦${amount.toFixed(2)} to ${accountName} initiated.`,
            transactionId: reference,
            type: 'withdrawal',
            status: 'pending',
            createdAt: new Date(),
          },
        ],
        { session }
      );

      const transferResponse = await retryAsync(() =>
        axios.post(
          'https://api.paystack.co/transfer',
          {
            source: 'balance',
            amount: amount * 100,
            recipient: recipientCode,
            reason: `Withdrawal from wallet (Ref: ${reference})`,
          },
          { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 10000 }
        )
      );

      if (!transferResponse.data.status) {
        throw new Error(transferResponse.data.message || 'Failed to initiate transfer');
      }

      wallet.transactions = wallet.transactions.map((tx) =>
        tx.reference === reference ? { ...tx, status: 'completed', updatedAt: new Date() } : tx
      );
      await wallet.save({ session });

      require('../utils/socket').emitBalanceUpdate(userId, {
        balance: wallet.balance,
        reference,
        transaction,
      });

      res.status(200).json({
        success: true,
        message: `Withdrawal of ₦${amount.toFixed(2)} initiated`,
        data: { reference, amount, bankCode, accountName, status: 'completed' },
      });
    });
  } catch (error) {
    logger.error('Withdraw funds error', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(400).json({ success: false, error: error.message });
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
    const minimumBalance = 100;

    if (revenueBalance < minimumBalance) {
      console.warn('Low Paystack revenue balance:', { revenueBalance });
      await Notification.create({
        userId: null,
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
      userId: null,
      title: 'Paystack Balance Check Failure',
      message: `Failed to check Paystack balance: ${error.message}`,
      type: 'system',
      status: 'error',
    });
  }
};