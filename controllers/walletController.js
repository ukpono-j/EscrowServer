const mongoose = require('mongoose');
const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const Notification = require('../modules/Notification');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

// Updated bank codes - using correct Paystack codes
const CRITICAL_BANKS = [
  { name: "Access Bank", code: "044" },
  { name: "Opay", code: "999992" }, // Fixed: Correct Opay code
  { name: "Kuda Bank", code: "090267" },
  { name: "Zenith Bank", code: "057" },
  { name: "Moniepoint Microfinance Bank", code: "50515" },
  { name: "Palmpay", code: "999991" }, // Fixed: Correct Palmpay code
  { name: "First Bank", code: "011" },
  { name: "GTBank", code: "058" },
  { name: "UBA", code: "033" },
  { name: "Fidelity Bank", code: "070" },
];


// Determine Paystack secret key based on environment
const PAYSTACK_SECRET_KEY =
  process.env.NODE_ENV === 'production'
    ? process.env.PAYSTACK_LIVE_SECRET_KEY
    : process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET_KEY) {
  console.error('Paystack secret key is not set. Check PAYSTACK_TEST_SECRET_KEY or PAYSTACK_LIVE_SECRET_KEY in .env.');
  process.exit(1);
}
// List of fallback banks for production mode
const FALLBACK_BANKS = [
  'wema-bank',
  'zenith-bank',
  'uba', // United Bank for Africa
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

// NEW: Function to transfer funds from Revenue to Transfer balance
const transferToPaystackTransferBalance = async (amount, reason = 'Fund Transfer Balance') => {
  return limiter.schedule(async () => {
    try {
      console.log('Initiating transfer to Paystack Transfer balance:', { amount, reason });
      // Check Revenue balance first
      const balanceResponse = await axios.get('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      if (!balanceResponse.data?.status) {
        throw new Error('Failed to check Paystack balance');
      }
      const revenueBalance = balanceResponse.data.data.find(b => b.balance_type === 'revenue')?.balance / 100 || 0;
      if (revenueBalance < amount) {
        console.error('Insufficient Revenue balance:', { revenueBalance, required: amount });
        await Notification.create({
          userId: 'admin', // Replace with actual admin ID
          title: 'Low Revenue Balance Alert',
          message: `Revenue balance (₦${revenueBalance.toFixed(2)}) is insufficient for transfer of ₦${amount.toFixed(2)}.`,
          type: 'admin_alert',
          status: 'pending',
        });
        throw new Error('Insufficient funds in Revenue balance');
      }

      const response = await axios.post(
        'https://api.paystack.co/balance/transfer',
        {
          source: 'revenue',
          amount: Math.round(amount * 100), // Convert to kobo
          currency: 'NGN',
          reason,
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      if (!response.data.status) {
        throw new Error(response.data.message || 'Failed to transfer to Transfer balance');
      }

      console.log('Transfer to Transfer balance successful:', response.data.data);
      return response.data.data;
    } catch (error) {
      logger.error('Error transferring to Paystack Transfer balance', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw error;
    }
  });
};

// Helper to validate Paystack balance
const validatePaystackBalance = async (customerCode, localDeposits, localWithdrawals, walletId) => {
  return limiter.schedule(async () => {
    try {
      const response = await axios.get(
        `https://api.paystack.co/transaction?customer=${customerCode}&status=success&perPage=100`,
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 10000,
        }
      );

      if (!response.data.status) {
        throw new Error('Invalid Paystack response');
      }

      const paystackDeposits = response.data.data
        .filter(t => t.status === 'success' && t.amount > 0)
        .reduce((sum, t) => sum + (t.amount / 100), 0);

      const discrepancy = Math.abs(paystackDeposits - localDeposits);
      if (discrepancy > 0.01) {
        console.error('Balance discrepancy detected:', {
          walletId,
          localDeposits,
          paystackDeposits,
          discrepancy,
        });
        await Notification.create({
          userId: walletId,
          title: 'Critical Balance Discrepancy',
          message: `Paystack balance (₦${paystackDeposits}) does not match local balance (₦${localDeposits})`,
          type: 'system',
          status: 'error',
        });
        throw new Error(`Balance discrepancy: Paystack ₦${paystackDeposits} vs Local ₦${localDeposits}`);
      }

      return { paystackDeposits, transactions: response.data.data };
    } catch (error) {
      console.error('Paystack balance validation error:', error.message);
      throw error;
    }
  });
};

exports.getWalletBalance = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
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

      let syncWarning = null;
      try {
        await wallet.syncBalanceWithPaystack();
      } catch (syncError) {
        console.error('Paystack sync error:', {
          userId: req.user.id,
          message: syncError.message,
          stack: syncError.stack,
        });
        syncWarning = 'Balance sync with payment provider failed. Displaying last known balance.';
        wallet.lastSynced = wallet.lastSynced || new Date();
      }

      await wallet.save({ session });

      // CONSISTENT STRUCTURE: Wrap data in 'data' object like sync endpoint
      res.status(200).json({
        success: true,
        data: {
          balance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
          currency: wallet.currency,
          walletId: wallet._id,
          virtualAccount: wallet.virtualAccount,
          lastSynced: wallet.lastSynced.toISOString(),
        },
        ...(syncWarning && { warning: syncWarning }),
      });
    });
  } catch (error) {
    console.error('Get balance error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch balance',
    });
  } finally {
    session.endSession();
  }
};

// MODIFIED: Enhanced initiateFunding to ensure funds go to Transfer balance
exports.initiateFunding = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { amount, email, phoneNumber } = req.body;
      const userId = req.user.id;
      const amountNum = parseFloat(amount);

      console.log('Initiating funding:', { userId, amount: amountNum, email, phoneNumber });

      if (!amountNum || amountNum <= 0) {
        console.warn('Invalid amount:', amountNum);
        return res.status(400).json({ success: false, error: 'Invalid or missing amount' });
      }

      if (amountNum < 100) {
        return res.status(400).json({ success: false, error: 'Minimum funding amount is ₦100' });
      }

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        console.warn('Invalid email:', email);
        return res.status(400).json({ success: false, error: 'Invalid or missing email' });
      }

      if (!phoneNumber || !/^(0\d{10}|\+234\d{10})$/.test(phoneNumber)) {
        console.warn('Invalid phone number:', phoneNumber);
        return res.status(400).json({ success: false, error: 'Invalid or missing phone number (must be 11 digits starting with 0 or +234)' });
      }

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        console.log('Creating new wallet for user:', userId);
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
        console.error('User not found:', userId);
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      let customerCode = user.paystackCustomerCode;
      if (!customerCode) {
        console.log('Creating Paystack customer for:', email);
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

        if (!customerResponse.data.status || !customerResponse.data.data?.customer_code) {
          console.error('Paystack customer creation failed:', customerResponse.data);
          throw new Error('Failed to create Paystack customer');
        }

        customerCode = customerResponse.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await user.save({ session });
        console.log('Paystack customer created:', customerCode);
      }

      let virtualAccount = wallet.virtualAccount;
      let shouldCreateNewAccount = false;

      if (!virtualAccount || !virtualAccount.account_number || !virtualAccount.bank_name) {
        shouldCreateNewAccount = true;
        console.log('No existing virtual account found, creating new one');
      } else {
        try {
          const verifyResponse = await axios.get(
            `https://api.paystack.co/dedicated_account/${virtualAccount.provider_reference}`,
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
              timeout: 10000,
            }
          );

          if (!verifyResponse.data.status || !verifyResponse.data.data.active) {
            console.log('Existing virtual account is not active, creating new one');
            shouldCreateNewAccount = true;
          }
        } catch (verifyError) {
          console.warn('Could not verify existing virtual account:', verifyError.message);
          shouldCreateNewAccount = true;
        }
      }

      if (shouldCreateNewAccount) {
        const banksToTry = process.env.NODE_ENV === 'production'
          ? ['wema-bank', 'access-bank', 'gtbank', 'sterling-bank']
          : ['wema-bank', 'titan-paystack'];

        console.log('Attempting virtual account creation with banks:', banksToTry);

        let accountResponse = null;
        let lastError = null;

        for (const bank of banksToTry) {
          try {
            console.log(`Trying bank: ${bank}`);
            accountResponse = await axios.post(
              'https://api.paystack.co/dedicated_account',
              {
                customer: customerCode,
                preferred_bank: bank,
                // NEW: Specify split configuration to route to Transfer balance
                split_config: {
                  subaccount: null, // Ensure funds go to main Transfer balance
                },
              },
              {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
                timeout: 20000,
              }
            );

            if (accountResponse.data.status && accountResponse.data.data) {
              console.log(`Virtual account created successfully with bank: ${bank}`);
              break;
            } else {
              throw new Error(`Bank ${bank} returned unsuccessful response`);
            }
          } catch (bankError) {
            console.warn(`Bank ${bank} failed:`, bankError.message);
            lastError = bankError;
            if (bank !== banksToTry[banksToTry.length - 1]) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }

        if (!accountResponse?.data?.status || !accountResponse.data.data) {
          console.error('All banks failed for virtual account creation');
          throw new Error(`Unable to create virtual account with any bank. Last error: ${lastError?.message || 'Unknown error'}`);
        }

        const accountData = accountResponse.data.data;
        if (!accountData.account_name || !accountData.account_number || !accountData.bank?.name) {
          console.error('Invalid virtual account data received:', accountData);
          throw new Error('Invalid virtual account data from Paystack');
        }

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

      console.log('Virtual account and transaction saved:', {
        reference,
        virtualAccountId: virtualAccount.provider_reference,
        accountNumber: virtualAccount.account_number,
      });

      await Notification.create(
        [{
          userId,
          title: 'Funding Initiated',
          message: `Funding request of ₦${amountNum.toFixed(2)} initiated. Use the virtual account details to complete payment.`,
          transactionId: reference,
          type: 'funding',
          status: 'pending',
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
    console.error('Funding error:', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
      status: error.response?.status,
      data: error.response?.data,
    });

    try {
      await Notification.create([{
        userId: req.user.id,
        title: 'Funding Request Failed',
        message: `Unable to initiate funding: ${error.message}`,
        transactionId: `FUND_ERROR_${Date.now()}`,
        type: 'funding',
        status: 'failed',
      }]);
    } catch (notificationError) {
      console.error('Failed to create error notification:', notificationError.message);
    }

    let statusCode = 500;
    let errorMessage = 'Failed to initiate funding';

    if (error.message.includes('customer')) {
      statusCode = 400;
      errorMessage = 'Failed to create or verify customer account';
    } else if (error.message.includes('virtual account') || error.message.includes('banks failed')) {
      statusCode = 503;
      errorMessage = 'Payment service temporarily unavailable. Please try again later.';
    } else if (error.response?.status === 401) {
      statusCode = 500;
      errorMessage = 'Payment service configuration error';
    } else if (error.response?.status === 429) {
      statusCode = 429;
      errorMessage = 'Too many requests. Please try again in a few minutes.';
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      statusCode = 504;
      errorMessage = 'Payment service timeout. Please try again.';
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  } finally {
    await session.endSession();
  }
};

// MODIFIED: Enhanced verifyFunding to handle balance transfer
exports.verifyFunding = async (req, res) => {
  return limiter.schedule(async () => {
    try {
      const { event, data } = req.body;
      if (!['dedicatedaccount.credit', 'charge.success'].includes(event)) {
        console.log('Ignoring non-relevant Paystack event:', event);
        return res.status(200).json({ status: 'success' });
      }

      const { reference, amount, status, customer, account_details } = data;
      if (!reference || !amount || !status || !customer?.email) {
        console.error('Invalid webhook payload:', { event, data });
        return res.status(400).json({ success: false, error: 'Invalid webhook payload' });
      }

      console.log('Processing webhook event:', { event, reference, amount, customerEmail: customer.email });

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const user = await User.findOne({ email: customer.email }).session(session);
          if (!user) {
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
            console.log('Transaction already processed:', reference);
            return res.status(200).json({ status: 'success' });
          }

          const amountInNaira = parseFloat(amount) / 100;
          let transaction = wallet.transactions.find(
            t =>
              t.paystackReference === reference ||
              (t.metadata?.virtualAccountId === account_details?.id && t.status === 'pending')
          );

          if (!transaction) {
            console.log('Creating new transaction for:', reference);
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
          }

          if (status === 'success') {
            transaction.status = 'completed';
            // NEW: Ensure funds are in Transfer balance
            try {
              await transferToPaystackTransferBalance(amountInNaira, `Deposit for ${reference}`);
              transaction.metadata.transferredToBalance = true; // Set flag
              const balanceResponse = await axios.get('https://api.paystack.co/balance', {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                timeout: 10000,
              });
              if (!balanceResponse.data.status) {
                throw new Error('Failed to verify Paystack balance');
              }
              console.log('Paystack balance after transfer:', balanceResponse.data.data);
            } catch (balanceError) {
              console.error('Paystack balance transfer/check error:', balanceError.message);
              throw new Error('Failed to confirm funds in Paystack Transfer balance');
            }
          } else {
            transaction.status = 'failed';
            transaction.metadata.error = 'Transaction failed at Paystack';
          }

          transaction.paystackReference = reference;
          transaction.amount = amountInNaira;

          wallet.markModified('transactions');
          await wallet.syncBalanceWithPaystack();
          await wallet.save({ session });

          const notification = {
            userId: wallet.userId,
            title: status === 'success' ? 'Wallet Funded' : 'Funding Failed',
            message: status === 'success'
              ? `Wallet funded with ₦${amountInNaira.toFixed(2)}. Ref: ${transaction.reference}`
              : `Funding of ₦${amountInNaira.toFixed(2)} failed. Ref: ${transaction.reference}`,
            transactionId: transaction.reference,
            type: 'funding',
            status: status === 'success' ? 'completed' : 'failed',
          };
          await Notification.create([notification], { session });

          const io = req.app.get('io');
          if (io) {
            io.to(wallet.userId.toString()).emit('balanceUpdate', {
              balance: wallet.balance,
              totalDeposits: wallet.totalDeposits,
              transaction: { amount: amountInNaira, reference: transaction.reference, status: transaction.status },
            });
          }
        });
      } finally {
        session.endSession();
      }

      return res.status(200).json({ status: 'success' });
    } catch (error) {
      console.error('Webhook error:', {
        event: req.body.event,
        reference: req.body.data?.reference,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });
};

// New endpoint to manually sync balance with Paystack
exports.syncWalletBalance = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        return res.status(404).json({ success: false, error: 'Wallet not found' });
      }

      const oldBalance = wallet.balance;
      await wallet.syncBalanceWithPaystack();
      await wallet.save({ session });

      // Return consistent structure similar to getWalletBalance
      res.status(200).json({
        success: true,
        message: 'Balance synchronized',
        data: {
          balance: wallet.balance, // Add this for consistency
          oldBalance: oldBalance,
          newBalance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
          currency: wallet.currency,
          walletId: wallet._id,
          virtualAccount: wallet.virtualAccount,
          lastSynced: wallet.lastSynced.toISOString(),
        },
      });
    });
  } catch (error) {
    console.error('Manual sync error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to sync balance' });
  } finally {
    session.endSession();
  }
};


// Scheduled job function to periodically sync all wallets (call this with cron)
exports.syncAllWalletBalances = async () => {
  try {
    const wallets = await Wallet.find({});
    for (const wallet of wallets) {
      try {
        await wallet.syncBalanceWithPaystack();
        await wallet.save();
        console.log(`Synced wallet for user ${wallet.userId}`);
      } catch (error) {
        console.error(`Failed to sync wallet ${wallet._id}:`, error.message);
      }
    }
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
        return res.status(400).json({ success: false, error: 'Reference required' });
      }

      let wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet) {
        wallet = new Wallet({ userId, balance: 0, totalDeposits: 0, currency: 'NGN', transactions: [] });
        await wallet.save({ session });
      }

      let transaction = wallet.transactions.find(t => t.reference === reference);
      if (transaction && transaction.status === 'completed') {
        return res.status(200).json({ success: true, message: 'Transaction already completed', data: { transaction, newBalance: wallet.balance } });
      }

      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 15000 }
      );

      if (response.data.status && response.data.data?.status === 'success') {
        const { amount, reference: paymentReference, customer } = response.data.data;
        const amountInNaira = parseFloat(amount) / 100;

        if (!transaction) {
          transaction = {
            type: 'deposit',
            amount: amountInNaira,
            reference: paymentReference,
            status: 'completed',
            metadata: { paymentGateway: 'Paystack', customerEmail: customer.email, reconciledManually: true, reconciledAt: new Date() },
            createdAt: new Date(),
          };
          wallet.transactions.push(transaction);
        } else {
          transaction.status = 'completed';
          transaction.metadata.reconciledManually = true;
          transaction.metadata.reconciledAt = new Date();
        }

        wallet.markModified('transactions');
        await wallet.syncBalanceWithPaystack();
        await wallet.save({ session });

        await Notification.create([{
          userId: wallet.userId,
          title: 'Wallet Funded',
          message: `Wallet funded with ₦${amountInNaira} via manual reconciliation. Ref: ${reference}`,
          transactionId: reference,
          type: 'funding',
          status: 'completed',
        }], { session });

        const io = req.app.get('io');
        if (io) {
          io.to(wallet.userId.toString()).emit('balanceUpdate', {
            balance: wallet.balance,
            transaction: { amount: amountInNaira, reference, status: 'completed' },
          });
        }

        return res.status(200).json({
          success: true,
          message: 'Transaction reconciled',
          data: { transaction, newBalance: wallet.balance },
        });
      } else {
        if (transaction) {
          transaction.status = 'failed';
          await wallet.save({ session });
        }
        return res.status(200).json({
          success: false,
          message: 'Transaction not confirmed by Paystack',
          data: { status: response.data.data?.status || 'pending' },
        });
      }
    });
  } catch (error) {
    console.error('Manual reconciliation error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to reconcile transaction' });
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
        console.warn('No reference provided');
        return res.status(400).json({ success: false, error: 'Reference is required' });
      }

      console.log('Checking funding status:', reference);

      let wallet = await Wallet.findOne({ userId: req.user.id }).session(session);
      if (!wallet) {
        console.warn('Wallet not found, recreating:', req.user.id);
        wallet = new Wallet({
          userId: req.user.id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
        });
        await wallet.save({ session });
        console.log('Wallet recreated:', { userId: req.user.id, walletId: wallet._id });
      }

      let transaction = wallet.transactions.find(
        (t) => t.reference === reference || t.paystackReference === reference
      );

      if (!transaction) {
        console.log('Transaction not found locally, checking Paystack:', reference);
        const response = await axios.get(
          `https://api.paystack.co/transaction/verify/${reference}`,
          {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000,
          }
        );

        console.log('Paystack response:', response.data);

        if (response.data.status && response.data.data?.status === 'success') {
          const { amount, reference: paymentReference, customer } = response.data.data;
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
              paystackReference: paymentReference,
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
            transaction.status = 'completed';
            transaction.paystackReference = paymentReference;
            transaction.metadata.reconciledManually = true;
            transaction.metadata.reconciledAt = new Date();
          }

          wallet.markModified('transactions');
          await wallet.syncBalanceWithPaystack(); // Sync with Paystack
          await wallet.save({ session });

          await Notification.create([{
            userId: wallet.userId,
            title: 'Wallet Funded Successfully',
            message: `Your wallet has been funded with ${amountInNaira} NGN. Reference: ${transaction.reference}.`,
            transactionId: transaction.reference,
            type: 'funding',
            status: 'completed',
          }], { session });

          const io = req.app.get('io');
          if (io) {
            io.to(wallet.userId.toString()).emit('balanceUpdate', {
              balance: wallet.balance,
              totalDeposits: wallet.totalDeposits,
              transaction: {
                amount: amountInNaira,
                reference: transaction.reference,
                status: 'completed',
              },
            });
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
          console.log('Paystack verification pending:', response.data);
          await wallet.syncBalanceWithPaystack(); // Sync even for pending/failed
          await wallet.save({ session });
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
      }

      console.log('Transaction status:', {
        reference,
        status: transaction.status,
        amount: transaction.amount,
        balance: wallet.balance,
      });

      await wallet.syncBalanceWithPaystack(); // Always sync before returning
      await wallet.save({ session });

      return res.status(200).json({
        success: true,
        message: transaction.status === 'completed' ? 'Payment confirmed' : transaction.status === 'failed' ? 'Payment failed' : 'Payment pending',
        data: {
          transaction,
          newBalance: wallet.balance,
          lastSynced: new Date().toISOString(),
        },
      });
    });
  } catch (error) {
    console.error('Check funding status error:', { reference: req.params.reference, message: error.message });
    let errorMessage = 'Failed to verify transaction';
    let statusCode = 502;
    if (error.code === 'ECONNABORTED') {
      errorMessage = 'Payment provider timeout.';
    } else if (error.response?.status === 401) {
      errorMessage = 'Invalid Paystack API key.';
      statusCode = 401;
    } else if (error.response?.status === 429) {
      errorMessage = 'Too many requests.';
      statusCode = 429;
    } else if (error.response?.status === 404) {
      errorMessage = 'Transaction not found.';
      statusCode = 404;
    }
    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: error.response?.data?.message || error.message,
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
              tx.status = 'completed';
              tx.metadata.reconciledManually = true;
              tx.metadata.reconciledAt = new Date();
              wallet.markModified('transactions');

              await Notification.create([{
                userId: wallet.userId,
                title: 'Wallet Funded Successfully',
                message: `Your wallet has been funded with ${(response.data.data.amount / 100)} NGN. Transaction reference: ${tx.reference}.`,
                transactionId: tx.reference,
                type: 'funding',
                status: 'completed',
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
            continue;
          }
        }

        await wallet.syncBalanceWithPaystack(); // Sync after processing transactions
        await wallet.save({ session });
        console.log('Wallet synced and saved:', { userId: wallet.userId, newBalance: wallet.balance });

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
////changed

// Helper function to get the appropriate Paystack secret key
const getPaystackSecretKey = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secretKey = isProduction
    ? process.env.PAYSTACK_LIVE_SECRET_KEY
    : process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    console.error(`PAYSTACK_${isProduction ? 'LIVE_' : ''}SECRET_KEY is not set in environment variables`);
    throw new Error(`PAYSTACK_${isProduction ? 'LIVE_' : ''}SECRET_KEY not configured`);
  }

  return secretKey;
};

// Enhanced bank code validation
const validateBankCode = (bankCode) => {
  // Check if bank code exists in critical banks or is a valid format
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

// MODIFIED: Enhanced verifyAccount with better error handling
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

// MODIFIED: Enhanced withdrawFunds to check Transfer balance
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

      // NEW: Check Paystack Transfer balance
      const balanceResponse = await axios.get('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      if (!balanceResponse.data?.status) {
        throw new Error('Failed to check Paystack balance');
      }

      const transferBalance = balanceResponse.data.data.find(b => b.balance_type === 'transfers')?.balance / 100 || 0;
      if (transferBalance < amountNum) {
        // Attempt to transfer funds from Revenue to Transfer balance
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
          source: 'balance', // This uses the Transfer balance
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

// Helper function to check Paystack account balance (optional enhancement)
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

// Updated webhook handler with better balance management
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

// Updated bank list fetcher with correct codes and better error handling
exports.getPaystackBanks = async (req, res) => {
  try {
    console.log('Fetching bank list...');

    let secretKey;
    try {
      secretKey = getPaystackSecretKey();
    } catch (error) {
      console.warn('Unable to get Paystack secret key, using fallback bank list');
      // Return critical banks as fallback
      return res.status(200).json({
        success: true,
        data: CRITICAL_BANKS.sort((a, b) => a.name.localeCompare(b.name)),
        message: 'Using cached bank list - service temporarily limited',
        fallback: true
      });
    }

    try {
      const response = await axios.get('https://api.paystack.co/bank', {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        params: {
          country: 'nigeria',
          use_cursor: false,
          perPage: 100
        },
        timeout: 10000,
      });

      if (response.data?.status && Array.isArray(response.data.data)) {
        const banks = response.data.data
          .map(bank => ({
            name: bank.name.trim(),
            code: bank.code,
            active: bank.active !== false, // Default to true if not specified
            type: bank.type || 'commercial'
          }))
          .filter(bank => bank.name && bank.code && bank.active);

        // Merge with critical banks to ensure they're included
        const banksMap = new Map();

        // Add API banks first
        banks.forEach(bank => banksMap.set(bank.code, bank));

        // Ensure critical banks are included (they override API data if present)
        CRITICAL_BANKS.forEach(bank => {
          if (!banksMap.has(bank.code)) {
            banksMap.set(bank.code, { ...bank, active: true, type: 'commercial' });
          }
        });

        const finalBanks = Array.from(banksMap.values())
          .filter(bank => bank.active) // Only return active banks
          .sort((a, b) => a.name.localeCompare(b.name));

        console.log(`Successfully fetched ${finalBanks.length} active banks from Paystack API`);

        return res.status(200).json({
          success: true,
          data: finalBanks,
          source: 'paystack_api',
          count: finalBanks.length
        });
      } else {
        throw new Error('Invalid response format from Paystack API');
      }
    } catch (apiError) {
      console.error('Failed to fetch banks from Paystack API:', {
        message: apiError.message,
        status: apiError.response?.status,
        statusText: apiError.response?.statusText
      });

      // Log specific API errors for debugging
      if (apiError.response?.status === 401) {
        console.error('Paystack API authentication failed - check API keys');
      } else if (apiError.response?.status === 403) {
        console.error('Paystack API access forbidden - account may be restricted');
      } else if (apiError.response?.status >= 500) {
        console.error('Paystack API server error - service may be down');
      }
    }

    // Fallback to critical banks with additional metadata
    console.log('Using fallback bank list due to API unavailability');
    return res.status(200).json({
      success: true,
      data: CRITICAL_BANKS.map(bank => ({
        ...bank,
        active: true,
        type: 'commercial'
      })).sort((a, b) => a.name.localeCompare(b.name)),
      source: 'fallback',
      message: 'Using fallback bank list - API temporarily unavailable',
      fallback: true,
      count: CRITICAL_BANKS.length
    });

  } catch (error) {
    console.error('Get banks error:', {
      message: error.message,
      stack: error.stack
    });

    return res.status(200).json({
      success: true,
      data: CRITICAL_BANKS.map(bank => ({
        ...bank,
        active: true,
        type: 'commercial'
      })).sort((a, b) => a.name.localeCompare(b.name)),
      source: 'fallback',
      message: 'Using fallback bank list due to system error',
      fallback: true,
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal error',
      count: CRITICAL_BANKS.length
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
      transactions,
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