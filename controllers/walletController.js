const mongoose = require('mongoose');
const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const Notification = require('../modules/Notification');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
// const FALLBACK_BANKS = ['wema-bank', 'titan-paystack', 'providus-bank'];


// Determine Paystack secret key based on environment
const PAYSTACK_SECRET_KEY =
  process.env.NODE_ENV === 'production'
    ? process.env.PAYSTACK_LIVE_SECRET_KEY
    : process.env.PAYSTACK_TEST_SECRET_KEY;

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

exports.getWalletBalance = async (req, res) => {
  try {
    console.log('Fetching wallet balance for user:', req.user.id);
    let wallet = await Wallet.findOne({ userId: req.user.id });

    if (!wallet) {
      console.warn('Wallet not found, recreating:', req.user.id);
      const user = await User.findById(req.user.id);
      if (!user) {
        console.error('User not found:', req.user.id);
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      wallet = new Wallet({
        userId: req.user.id,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
        virtualAccount: null,
      });
      await wallet.save();
      console.log('Wallet recreated:', { userId: req.user.id, walletId: wallet._id });
    }

    await wallet.recalculateBalance();
    console.log('Wallet balance fetched:', {
      walletId: wallet._id,
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
      transactionCount: wallet.transactions.length,
    });

    res.status(200).json({
      success: true,
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
      currency: wallet.currency,
      walletId: wallet._id,
      virtualAccount: wallet.virtualAccount,
    });
  } catch (error) {
    console.error('Get balance error:', { userId: req.user.id, message: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.initiateFunding = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, email, phoneNumber } = req.body;

    console.log('Initiating funding:', { userId, amount, email, phoneNumber });

    if (!amount || amount <= 0 || !email || !phoneNumber) {
      console.warn('Invalid funding request:', { amount, email, phoneNumber });
      return res.status(400).json({ success: false, error: 'Amount, email, and phone number are required' });
    }

    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      console.warn('Wallet not found, creating:', userId);
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
        virtualAccount: null,
      });
      await wallet.save();
      console.log('Wallet created:', { userId, walletId: wallet._id });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.error('User not found:', userId);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    let customerCode;
    if (!user.paystackCustomerCode) {
      const customerResponse = await axios.post(
        'https://api.paystack.co/customer',
        {
          email: user.email,
          first_name: user.firstName || 'Unknown',
          last_name: user.lastName || 'Unknown',
          phone: phoneNumber,
        },
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );

      if (!customerResponse.data.status || !customerResponse.data.data?.customer_code) {
        console.error('Failed to create Paystack customer:', customerResponse.data);
        throw new Error('Failed to create Paystack customer');
      }

      customerCode = customerResponse.data.data.customer_code;
      user.paystackCustomerCode = customerCode;
      await user.save();
      console.log('Paystack customer created:', { userId, customerCode });
    } else {
      customerCode = user.paystackCustomerCode;
      try {
        const customerVerification = await axios.get(
          `https://api.paystack.co/customer/${customerCode}`,
          {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000,
          }
        );
        if (!customerVerification.data.status || !customerVerification.data.data) {
          console.warn('Customer code invalid, clearing:', customerCode);
          user.paystackCustomerCode = null;
          await user.save();
          return exports.initiateFunding(req, res);
        }
        console.log('Customer verified:', { customerCode });
      } catch (error) {
        console.error('Error verifying Paystack customer:', error.message);
        user.paystackCustomerCode = null;
        await user.save();
        return exports.initiateFunding(req, res);
      }
    }

    let accountResponse;
    if (process.env.NODE_ENV === 'production') {
      for (const bank of FALLBACK_BANKS) {
        try {
          console.log(`Attempting virtual account with bank: ${bank}`);
          accountResponse = await axios.post(
            'https://api.paystack.co/dedicated_account',
            { customer: customerCode, preferred_bank: bank },
            {
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
              timeout: 30000,
            }
          );
          if (accountResponse.data.status) {
            console.log(`Virtual account created with bank: ${bank}`);
            break;
          }
        } catch (bankError) {
          console.warn(`Failed with bank ${bank}:`, bankError.message);
          if (bank === FALLBACK_BANKS[FALLBACK_BANKS.length - 1]) {
            console.log('All fallback banks failed, trying default: wema-bank');
            accountResponse = await axios.post(
              'https://api.paystack.co/dedicated_account',
              { customer: customerCode, preferred_bank: 'wema-bank' },
              {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
                timeout: 30000,
              }
            );
            if (!accountResponse.data.status) {
              throw new Error('All banks failed to create virtual account');
            }
          }
        }
      }
    } else {
      accountResponse = await axios.post(
        'https://api.paystack.co/dedicated_account',
        { customer: customerCode },
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
    }

    if (!accountResponse.data.status || !accountResponse.data.data) {
      console.error('Failed to create virtual account:', accountResponse.data);
      throw new Error(accountResponse.data.message || 'Failed to create virtual account');
    }

    const accountData = accountResponse.data.data;
    if (!accountData.account_name || !accountData.account_number || !accountData.bank?.name) {
      console.error('Invalid virtual account data:', accountData);
      throw new Error('Invalid virtual account data');
    }

    const virtualAccount = {
      account_name: accountData.account_name,
      account_number: accountData.account_number,
      bank_name: accountData.bank.name,
      provider: 'Paystack',
      provider_reference: accountData.id,
      dedicated_reference: accountData.dedicated_account?.assignment?.integration_reference || null,
    };

    wallet.virtualAccount = virtualAccount;

    const reference = `FUND_${userId}_${uuidv4()}`;
    const transaction = {
      type: 'deposit',
      amount: parseFloat(amount),
      reference,
      paystackReference: null,
      status: 'pending',
      metadata: {
        paymentGateway: 'Paystack',
        customerEmail: email,
        virtualAccount,
        virtualAccountId: accountData.id,
      },
      createdAt: new Date(),
    };
    wallet.transactions.push(transaction);

    await wallet.save();
    console.log('Virtual account and transaction saved:', {
      userId,
      reference,
      virtualAccountId: accountData.id,
      amount: transaction.amount,
    });

    return res.status(200).json({
      success: true,
      message: 'Virtual account created successfully',
      data: {
        virtualAccount,
        reference,
        amount: parseFloat(amount),
      },
    });
  } catch (error) {
    console.error('Error creating virtual account:', error.message);
    await Notification.create({
      userId: req.user.id,
      title: 'Funding Request Failed',
      message: 'Unable to create virtual account for funding.',
      transactionId: `FUND_${Date.now()}`,
      type: 'funding',
      status: 'cancelled',
    });
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to create virtual account.',
    });
  }
};

exports.verifyFunding = async (req, res) => {
  try {
    console.log('Webhook received:', {
      timestamp: new Date().toISOString(),
      headers: req.headers,
      body: req.body,
      remoteAddress: req.ip,
      url: req.originalUrl,
      method: req.method,
    });

    const webhookData = req.body;
    const { event, data } = webhookData;

    if (!['dedicatedaccount.credit', 'charge.success'].includes(event)) {
      console.log('Ignoring webhook event:', { event, reference: data?.reference });
      return res.status(200).json({ status: 'success' });
    }

    const { reference, amount, status, customer, account_details } = data;
    if (!reference || !amount || !status || !customer?.email) {
      console.error('Invalid webhook payload:', { reference, amount, status, customerEmail: customer?.email });
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Find wallet by customer email or virtual account ID
    const user = await User.findOne({ email: customer.email });
    if (!user) {
      console.error('No user found for webhook email:', { email: customer.email, reference });
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    let wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      console.warn('Wallet not found, creating:', user._id);
      wallet = new Wallet({
        userId: user._id,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
        virtualAccount: null,
      });
      await wallet.save();
      console.log('Wallet created:', { userId: user._id, walletId: wallet._id });
    }

    // Update virtual account if provided
    if (event === 'dedicatedaccount.credit' && account_details) {
      if (!wallet.virtualAccount && account_details.account_name && account_details.account_number && account_details.bank_name) {
        wallet.virtualAccount = {
          account_name: account_details.account_name,
          account_number: account_details.account_number,
          bank_name: account_details.bank_name,
          provider: 'Paystack',
          provider_reference: account_details.id || null,
          dedicated_reference: account_details.dedicated_reference || null,
        };
        await wallet.save();
        console.log('Virtual account updated:', wallet.virtualAccount);
      }
    }

    // Find transaction by virtualAccountId or original reference
    let transaction = wallet.transactions.find(
      (t) =>
        (t.metadata?.virtualAccountId === account_details?.id && t.status === 'pending' && t.type === 'deposit') ||
        t.reference === reference ||
        t.paystackReference === reference
    );

    if (!transaction) {
      console.warn('No matching transaction found, searching by user and amount:', { reference, amount, userId: user._id });
      transaction = wallet.transactions.find(
        (t) =>
          t.type === 'deposit' &&
          t.status === 'pending' &&
          t.amount === parseFloat(amount) / 100 &&
          t.metadata?.customerEmail === customer.email
      );
    }

    if (transaction && transaction.status === 'completed') {
      console.log('Duplicate webhook ignored:', { reference, walletId: wallet._id });
      return res.status(200).json({ status: 'success' });
    }

    const amountInNaira = parseFloat(amount) / 100;

    // Create new transaction only if no match found
    if (!transaction) {
      console.warn('Creating new transaction as no match found:', { reference, amountInNaira });
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
    } else {
      // Update existing transaction
      transaction.paystackReference = reference;
      transaction.amount = amountInNaira;
      transaction.metadata.webhookEvent = event;
      console.log('Matched and updated transaction:', {
        reference: transaction.reference,
        paystackReference: reference,
        amount: amountInNaira,
      });
    }

    // Update transaction status
    transaction.status = status === 'success' ? 'completed' : 'failed';
    let notification;

    if (status === 'success') {
      wallet.totalDeposits += amountInNaira;
      notification = {
        userId: wallet.userId,
        title: 'Wallet Funded Successfully',
        message: `Your wallet has been funded with ${amountInNaira} NGN. Reference: ${transaction.reference}.`,
        transactionId: transaction.reference,
        type: 'funding',
        status: 'completed',
      };
      console.log('Transaction updated:', {
        reference: transaction.reference,
        paystackReference: reference,
        amount: amountInNaira,
        status: transaction.status,
      });
    } else {
      notification = {
        userId: wallet.userId,
        title: 'Wallet Funding Failed',
        message: `Funding of ${amountInNaira} NGN failed. Reference: ${transaction.reference}.`,
        transactionId: transaction.reference,
        type: 'funding',
        status: 'failed',
      };
    }

    wallet.markModified('transactions');

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await wallet.save({ session });
        console.log('Wallet saved with transaction:', {
          walletId: wallet._id,
          transactionReference: transaction.reference,
          transactionStatus: transaction.status,
        });

        await wallet.recalculateBalance();
        console.log('Balance after recalculation:', {
          walletId: wallet._id,
          balance: wallet.balance,
        });

        await wallet.save({ session });
        await Notification.create([notification], { session });
      });

      console.log('Wallet and notification saved:', {
        walletId: wallet._id,
        balance: wallet.balance,
        reference: transaction.reference,
      });
    } catch (saveError) {
      console.error('Transaction save failed:', { reference, message: saveError.message });
      throw saveError;
    } finally {
      session.endSession();
    }

    const io = req.app.get('io');
    if (io) {
      io.to(wallet.userId.toString()).emit('balanceUpdate', {
        balance: wallet.balance,
        transaction: {
          amount: amountInNaira,
          reference: transaction.reference,
          status: transaction.status,
        },
      });
      console.log('WebSocket balance update emitted:', { userId: wallet.userId, reference: transaction.reference });
    } else {
      console.warn('Socket.io instance not found:', { reference });
    }

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Webhook processing error:', { message: error.message, body: req.body });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.manualReconcileTransaction = async (req, res) => {
  try {
    const { reference } = req.body;
    const userId = req.user.id;

    if (!reference) {
      console.warn('No reference provided for manual reconciliation');
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    console.log('Manual reconciliation started:', { reference, userId, timestamp: new Date().toISOString() });

    // Find or create wallet
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      console.warn('Wallet not found, creating new wallet:', { userId });
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet created:', { userId, walletId: wallet._id });
    }

    // Check for existing transaction
    let transaction = wallet.transactions.find((t) => t.reference === reference);
    if (transaction && transaction.status === 'completed') {
      console.log('Transaction already completed:', { reference, walletId: wallet._id });
      return res.status(200).json({
        success: true,
        message: 'Transaction already completed',
        data: { transaction, newBalance: wallet.balance },
      });
    }

    // Verify transaction with Paystack
    try {
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      console.log('Paystack manual reconciliation response:', JSON.stringify(response.data, null, 2));

      if (response.data.status && response.data.data?.status === 'success') {
        const { amount, reference: paymentReference, customer } = response.data.data;

        // Create or update transaction
        if (!transaction) {
          transaction = {
            type: 'deposit',
            amount: parseFloat(amount) / 100, // Convert kobo to NGN
            reference: paymentReference,
            status: 'completed',
            metadata: {
              paymentGateway: 'Paystack',
              paymentReference,
              customerEmail: customer.email,
              reconciledManually: true,
              reconciledAt: new Date(),
            },
            createdAt: new Date(),
          };
          wallet.transactions.push(transaction);
        } else {
          transaction.status = 'completed';
          transaction.metadata.reconciledManually = true;
          transaction.metadata.reconciledAt = new Date();
        }

        // Update wallet balance
        const amountInNaira = parseFloat(amount) / 100;
        wallet.balance += amountInNaira;
        wallet.totalDeposits += amountInNaira;

        // Save wallet with retry logic
        let saveAttempts = 0;
        const maxSaveAttempts = 3;
        while (saveAttempts < maxSaveAttempts) {
          try {
            await wallet.recalculateBalance();
            await wallet.save();
            console.log('Wallet saved successfully:', {
              walletId: wallet._id,
              balance: wallet.balance,
              reference,
            });
            break;
          } catch (saveError) {
            saveAttempts++;
            console.error('Wallet save attempt failed:', {
              attempt: saveAttempts,
              reference,
              message: saveError.message,
              stack: saveError.stack,
            });
            if (saveAttempts === maxSaveAttempts) {
              console.error('Max save attempts reached:', { reference, walletId: wallet._id });
              return res.status(500).json({
                success: false,
                error: 'Failed to save wallet after reconciliation',
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * saveAttempts));
          }
        }

        // Create notification
        let notificationAttempts = 0;
        const maxNotificationAttempts = 3;
        const notification = {
          userId: wallet.userId,
          title: 'Wallet Funded Successfully',
          message: `Your wallet has been funded with ${amountInNaira} NGN via manual reconciliation. Reference: ${reference}.`,
          transactionId: reference,
          type: 'funding',
          status: 'completed',
        };

        while (notificationAttempts < maxNotificationAttempts) {
          try {
            await Notification.create(notification);
            console.log('Notification created:', {
              reference,
              userId: wallet.userId,
              status: notification.status,
            });
            break;
          } catch (notifError) {
            notificationAttempts++;
            console.error('Notification save attempt failed:', {
              attempt: notificationAttempts,
              reference,
              message: notifError.message,
              stack: notifError.stack,
            });
            if (notificationAttempts === maxNotificationAttempts) {
              console.warn('Max notification save attempts reached, continuing without notification:', {
                reference,
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * notificationAttempts));
          }
        }

        // Emit WebSocket update
        const io = req.app.get('io');
        if (io) {
          io.to(wallet.userId.toString()).emit('balanceUpdate', {
            balance: wallet.balance,
            transaction: {
              amount: amountInNaira,
              reference,
              status: 'completed',
            },
          });
          console.log('WebSocket balance update emitted:', { userId: wallet.userId, reference });
        } else {
          console.warn('Socket.io instance not found for reconciliation:', { reference });
        }

        return res.status(200).json({
          success: true,
          message: 'Transaction reconciled successfully',
          data: { transaction, newBalance: wallet.balance },
        });
      } else {
        console.log('Paystack verification failed or pending:', response.data);
        if (transaction) {
          transaction.status = 'failed';
          await wallet.save();
        }
        return res.status(200).json({
          success: false,
          message: 'Transaction not confirmed by Paystack',
          data: { status: response.data.data?.status || 'pending' },
        });
      }
    } catch (error) {
      console.error('Paystack manual reconciliation error:', {
        reference,
        message: error.message,
        code: error.code,
        response: error.response?.data,
        status: error.response?.status,
      });

      let errorMessage = 'Failed to verify transaction with Paystack';
      let statusCode = 502;

      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
      } else if (error.response?.status === 401) {
        errorMessage = 'Invalid Paystack API key. Please contact support.';
        statusCode = 401;
      } else if (error.response?.status === 429) {
        errorMessage = 'Too many requests to the payment provider. Please try again later.';
        statusCode = 429;
      } else if (error.response?.status === 500) {
        errorMessage = 'Payment provider encountered an internal server error. Please try again later or contact support.';
        statusCode = 502;
      } else if (error.response?.status === 404) {
        errorMessage = 'Transaction not found in Paystack';
        statusCode = 404;
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: error.response?.data?.message || error.message,
      });
    }
  } catch (error) {
    console.error('Manual reconciliation error:', {
      reference: req.body.reference,
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Internal server error during manual reconciliation',
    });
  }
};


exports.checkFundingStatus = async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) {
      console.warn('No reference provided');
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    console.log('Checking funding status:', reference);

    let wallet = await Wallet.findOne({ userId: req.user.id });
    if (!wallet) {
      console.warn('Wallet not found, recreating:', req.user.id);
      wallet = new Wallet({
        userId: req.user.id,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet recreated:', { userId: req.user.id, walletId: wallet._id });
    }

    let transaction = wallet.transactions.find(
      (t) => t.reference === reference || t.paystackReference === reference
    );

    if (!transaction) {
      console.log('Transaction not found locally, checking Paystack:', reference);
      try {
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
              },
              createdAt: new Date(),
            };
            wallet.transactions.push(transaction);
          } else {
            transaction.status = 'completed';
            transaction.paystackReference = paymentReference;
          }

          wallet.totalDeposits += amountInNaira;
          await wallet.recalculateBalance();
          await wallet.save();

          await Notification.create({
            userId: wallet.userId,
            title: 'Wallet Funded Successfully',
            message: `Your wallet has been funded with ${amountInNaira} NGN. Reference: ${transaction.reference}.`,
            transactionId: transaction.reference,
            type: 'funding',
            status: 'completed',
          });

          const io = req.app.get('io');
          if (io) {
            io.to(wallet.userId.toString()).emit('balanceUpdate', {
              balance: wallet.balance,
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
            },
          });
        } else {
          console.log('Paystack verification pending:', response.data);
          return res.status(200).json({
            success: true,
            message: 'Payment not confirmed',
            data: { status: response.data.data?.status || 'pending' },
          });
        }
      } catch (error) {
        console.error('Paystack error:', { reference, message: error.message });
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
      }
    }

    console.log('Transaction status:', {
      reference,
      status: transaction.status,
      amount: transaction.amount,
      balance: wallet.balance,
    });

    if (transaction.status === 'completed') {
      await wallet.recalculateBalance();
      await wallet.save();
    }

    return res.status(200).json({
      success: true,
      message: transaction.status === 'completed' ? 'Payment confirmed' : transaction.status === 'failed' ? 'Payment failed' : 'Payment pending',
      data: {
        transaction,
        newBalance: wallet.balance,
      },
    });
  } catch (error) {
    console.error('Check funding status error:', { reference: req.params.reference, message: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.reconcileTransactions = async (req, res) => {
  try {
    console.log('Starting transaction reconciliation');
    const wallets = await Wallet.find({
      'transactions.status': 'pending',
    });

    const timeoutThreshold = 24 * 60 * 60 * 1000; // 24 hours

    for (const wallet of wallets) {
      for (const tx of wallet.transactions.filter((t) => t.status === 'pending')) {
        const transactionAge = Date.now() - new Date(tx.createdAt).getTime();
        if (transactionAge > timeoutThreshold) {
          console.log('Marking old transaction as failed:', tx.reference);
          tx.status = 'failed';
          tx.metadata.error = 'Transaction timed out';

          const notification = new Notification({
            userId: wallet.userId,
            title: 'Wallet Funding Timed Out',
            message: `Your wallet funding of ${tx.amount} NGN has timed out. Transaction reference: ${tx.reference}.`,
            transactionId: tx.reference,
            type: 'funding',
            status: 'failed',
          });
          await notification.save();
          console.log('Timeout notification created:', {
            userId: wallet.userId,
            reference: tx.reference,
          });

          await wallet.save();
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
            wallet.balance += parseFloat(response.data.data.amount) / 100;
            wallet.totalDeposits += parseFloat(response.data.data.amount) / 100;

            const notification = new Notification({
              userId: wallet.userId,
              title: 'Wallet Funded Successfully',
              message: `Your wallet has been funded with ${(response.data.data.amount / 100)} NGN. Transaction reference: ${tx.reference}.`,
              transactionId: tx.reference,
              type: 'funding',
              status: 'completed',
            });
            await notification.save();
            console.log('Reconciliation notification created:', {
              userId: wallet.userId,
              reference: tx.reference,
            });

            await wallet.recalculateBalance();
            await wallet.save();
            console.log('Manual reconciliation: Transaction completed:', {
              reference: tx.reference,
              amount: response.data.data.amount / 100,
              newBalance: wallet.balance,
            });

            const io = req.app.get('io');
            io.to(wallet.userId.toString()).emit('balanceUpdate', {
              balance: wallet.balance,
              transaction: {
                amount: parseFloat(response.data.data.amount) / 100,
                reference: tx.reference,
              },
            });
          } else if (response.data.data?.status === 'failed') {
            tx.status = 'failed';
            tx.metadata.error = response.data.data?.message || 'Payment failed';

            const notification = new Notification({
              userId: wallet.userId,
              title: 'Wallet Funding Failed',
              message: `Your wallet funding of ${tx.amount} NGN failed. Transaction reference: ${tx.reference}.`,
              transactionId: tx.reference,
              type: 'funding',
              status: 'failed',
            });
            await notification.save();
            console.log('Reconciliation failure notification created:', {
              userId: wallet.userId,
              reference: tx.reference,
            });

            await wallet.save();
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
    }

    console.log('Transaction reconciliation completed');
    return res.status(200).json({ success: true, message: 'Transaction reconciliation completed' });
  } catch (error) {
    console.error('Reconciliation error:', {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error during reconciliation' });
  }
};

exports.verifyAccount = async (req, res) => {
  try {
    const { bankCode, accountNumber } = req.body;
    const userId = req.user.id;

    console.log('Verifying account:', { userId, bankCode, accountNumber });

    if (!bankCode || !accountNumber || accountNumber.length !== 10) {
      console.warn('Invalid account details:', { bankCode, accountNumber });
      return res.status(400).json({ success: false, error: 'Valid bank code and 10-digit account number are required' });
    }

    try {
      const response = await axios.get(
        `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      console.log('Paystack verifyAccount response:', JSON.stringify(response.data, null, 2));

      if (response.data.status && response.data.data?.account_name) {
        return res.status(200).json({
          success: true,
          accountName: response.data.data.account_name,
        });
      }

      console.warn('Paystack verifyAccount failed:', response.data);
      return res.status(400).json({
        success: false,
        message: 'Account verification failed',
        error: response.data.message || 'Unknown error',
      });
    } catch (error) {
      console.error('Paystack verifyAccount error:', {
        endpoint: `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        code: error.code,
      });

      let errorMessage = 'Failed to verify account';
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
      } else if (error.response?.status === 401) {
        errorMessage = 'Invalid Paystack API key. Please contact support.';
      } else if (error.response?.status === 429) {
        errorMessage = 'Too many requests to the payment provider. Please try again later.';
      } else if (error.response?.status === 400) {
        errorMessage = 'Invalid account details. Please check and try again.';
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      }

      return res.status(error.response?.status || 502).json({
        success: false,
        message: errorMessage,
        error: error.message,
      });
    }
  } catch (error) {
    console.error('Verify account error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

exports.withdrawFunds = async (req, res) => {
  try {
    const { amount, bankCode, accountNumber, accountName } = req.body;
    const userId = req.user.id;

    console.log('Initiating withdrawal:', { userId, amount, bankCode, accountNumber, accountName });

    if (!amount || isNaN(amount) || amount <= 0) {
      console.warn('Invalid amount provided:', amount);
      return res.status(400).json({ success: false, error: 'Valid amount is required' });
    }
    if (!bankCode || !accountNumber || accountNumber.length !== 10 || !accountName) {
      console.warn('Invalid account details:', { bankCode, accountNumber, accountName });
      return res.status(400).json({ success: false, error: 'Valid bank code, 10-digit account number, and account name are required' });
    }

    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      console.warn('Wallet not found, recreating:', userId);
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet recreated for withdrawal:', { userId, walletId: wallet._id });
    }

    await wallet.recalculateBalance();
    if (wallet.balance < amount) {
      console.warn('Insufficient balance:', { userId, balance: wallet.balance, requestedAmount: amount });
      return res.status(400).json({ success: false, error: 'Insufficient wallet balance' });
    }

    const reference = `WD-${crypto.randomBytes(4).toString('hex')}-${Date.now()}`;
    console.log('Generated withdrawal reference:', reference);

    // Create a transfer recipient
    const recipientPayload = {
      type: 'nuban',
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    };

    let recipientResponse;
    try {
      recipientResponse = await axios.post(
        'https://api.paystack.co/transferrecipient',
        recipientPayload,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      console.log('Paystack create recipient response:', JSON.stringify(recipientResponse.data, null, 2));
    } catch (error) {
      console.error('Paystack create recipient error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        code: error.code,
      });

      let errorMessage = 'Failed to create transfer recipient';
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
      } else if (error.response?.status === 401) {
        errorMessage = 'Invalid Paystack API key. Please contact support.';
      } else if (error.response?.status === 429) {
        errorMessage = 'Too many requests to the payment provider. Please try again later.';
      } else if (error.response?.status === 400) {
        errorMessage = 'Invalid account details. Please check and try again.';
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      }

      const transaction = {
        type: 'withdrawal',
        amount: parseFloat(amount),
        reference,
        status: 'failed',
        metadata: {
          paymentGateway: 'Paystack',
          bankCode,
          accountNumber,
          accountName,
          error: errorMessage,
          errorDetails: error.response?.data || error.message,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);

      const notification = new Notification({
        userId,
        title: 'Withdrawal Failed',
        message: `Your withdrawal of ${amount} NGN failed: ${errorMessage}`,
        transactionId: reference,
        type: 'withdrawal',
        status: 'failed',
      });
      await notification.save();
      console.log('Failure notification created:', { userId, reference, errorMessage });

      await wallet.save();
      console.log('Failed withdrawal transaction saved:', { reference, walletId: wallet._id });

      return res.status(error.response?.status || 502).json({
        success: false,
        message: errorMessage,
        error: error.message,
      });
    }

    const recipientCode = recipientResponse.data.data.recipient_code;

    // Initiate the transfer
    const transferPayload = {
      source: 'balance',
      amount: amount * 100,
      reference,
      recipient: recipientCode,
      reason: 'Wallet withdrawal',
    };

    let transferResponse;
    try {
      transferResponse = await axios.post(
        'https://api.paystack.co/transfer',
        transferPayload,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      console.log('Paystack initiate transfer response:', JSON.stringify(transferResponse.data, null, 2));
    } catch (error) {
      console.error('Paystack initiate transfer error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        code: error.code,
      });

      let errorMessage = 'Failed to initiate withdrawal';
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
      } else if (error.response?.status === 401) {
        errorMessage = 'Invalid Paystack API key. Please contact support.';
      } else if (error.response?.status === 429) {
        errorMessage = 'Too many requests to the payment provider. Please try again later.';
      } else if (error.response?.status === 400) {
        errorMessage = 'Invalid withdrawal details. Please check and try again.';
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      }

      const transaction = {
        type: 'withdrawal',
        amount: parseFloat(amount),
        reference,
        status: 'failed',
        metadata: {
          paymentGateway: 'Paystack',
          bankCode,
          accountNumber,
          accountName,
          error: errorMessage,
          errorDetails: error.response?.data || error.message,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);

      const notification = new Notification({
        userId,
        title: 'Withdrawal Failed',
        message: `Your withdrawal of ${amount} NGN failed: ${errorMessage}`,
        transactionId: reference,
        type: 'withdrawal',
        status: 'failed',
      });
      await notification.save();
      console.log('Failure notification created:', { userId, reference, errorMessage });

      await wallet.save();
      console.log('Failed withdrawal transaction saved:', { reference, walletId: wallet._id });

      return res.status(error.response?.status || 502).json({
        success: false,
        message: errorMessage,
        error: error.message,
      });
    }

    if (transferResponse.data.status) {
      wallet.balance -= parseFloat(amount);
      const transaction = {
        type: 'withdrawal',
        amount: parseFloat(amount),
        reference,
        status: 'completed',
        metadata: {
          paymentGateway: 'Paystack',
          bankCode,
          accountNumber,
          accountName,
          transferCode: transferResponse.data.data.transfer_code,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);

      const notification = new Notification({
        userId,
        title: 'Withdrawal Successful',
        message: `Your withdrawal of ${amount} NGN to ${accountName} (${accountNumber}) has been processed. Transaction reference: ${reference}.`,
        transactionId: reference,
        type: 'withdrawal',
        status: 'completed',
      });
      await notification.save();
      console.log('Success notification created:', { userId, reference });

      await wallet.save();
      console.log('Withdrawal transaction saved:', { reference, walletId: wallet._id, newBalance: wallet.balance });

      const io = req.app.get('io');
      io.to(userId.toString()).emit('balanceUpdate', {
        balance: wallet.balance,
        transaction: {
          amount: parseFloat(amount),
          reference,
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Withdrawal processed successfully',
        data: {
          reference,
          newBalance: wallet.balance,
        },
      });
    }

    console.warn('Paystack initiate transfer failed:', transferResponse.data);
    const transaction = {
      type: 'withdrawal',
      amount: parseFloat(amount),
      reference,
      status: 'failed',
      metadata: {
        paymentGateway: 'Paystack',
        bankCode,
        accountNumber,
        accountName,
        error: transferResponse.data.message || 'Withdrawal failed',
      },
      createdAt: new Date(),
    };

    wallet.transactions.push(transaction);

    const notification = new Notification({
      userId,
      title: 'Withdrawal Failed',
      message: `Your withdrawal of ${amount} NGN failed: ${transferResponse.data.message || 'Unknown error'}`,
      transactionId: reference,
      type: 'withdrawal',
      status: 'failed',
    });
    await notification.save();
    console.log('Failure notification created:', { userId, reference });

    await wallet.save();
    console.log('Failed withdrawal transaction saved:', { reference, walletId: wallet._id });

    return res.status(400).json({
      success: false,
      message: 'Withdrawal failed',
      error: transferResponse.data.message || 'Unknown error',
    });
  } catch (error) {
    console.error('Withdraw funds error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });

    const notification = new Notification({
      userId: req.user.id,
      title: 'Withdrawal Error',
      message: 'An error occurred while processing your withdrawal. Please try again or contact support.',
      transactionId: `WD-ERROR-${Date.now()}`,
      type: 'withdrawal',
      status: 'failed',
    });
    await notification.save();
    console.log('General error notification created:', { userId: req.user.id });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
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