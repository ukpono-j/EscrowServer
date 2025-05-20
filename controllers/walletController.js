const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const Notification = require('../modules/Notification');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

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
        virtualAccount: null,
      });
      await wallet.save();
      console.log('Wallet recreated for user:', { userId: req.user.id, walletId: wallet._id });
    }

    await wallet.recalculateBalance();

    res.status(200).json({
      success: true,
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
      currency: wallet.currency,
      walletId: wallet._id,
      virtualAccount: wallet.virtualAccount,
    });
  } catch (error) {
    console.error('Get balance error:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.initiateFunding = async (req, res) => {
  try {
    const { amount, email, phoneNumber } = req.body;
    const userId = req.user.id;

    console.log('Initiating funding with inputs:', { userId, amount, email, phoneNumber });

    // Validate input
    if (!amount || amount <= 0) {
      console.warn('Invalid amount provided:', amount);
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (!email || !phoneNumber) {
      console.warn('Missing email or phone number:', { email, phoneNumber });
      return res.status(400).json({ success: false, message: 'Email and phone number are required' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      console.error('User not found:', userId);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Find or create wallet
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      console.log('Creating new wallet for user:', userId);
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
        virtualAccount: null,
      });
      await wallet.save();
      console.log('Wallet created:', wallet._id);
    }

    let virtualAccount = wallet.virtualAccount;
    let customerCode;

    // Create or fetch Paystack customer
    if (!virtualAccount) {
      console.log('Creating Paystack customer for:', email);
      try {
        const customerResponse = await axios.post(
          'https://api.paystack.co/customer',
          {
            email,
            first_name: user.firstName,
            last_name: user.lastName,
            phone: phoneNumber,
            metadata: { userId },
          },
          {
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!customerResponse.data.status) {
          console.error('Paystack customer creation failed:', customerResponse.data);
          throw new Error(customerResponse.data.message || 'Failed to create customer');
        }

        customerCode = customerResponse.data.data.customer_code;
        console.log('Paystack customer created:', customerCode);
      } catch (error) {
        console.error('Error creating Paystack customer:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
        });
        await Notification.create({
          userId,
          title: 'Funding Request Failed',
          message: 'Unable to create customer profile for funding. Please try again.',
          transactionId: `FUND_${Date.now()}`,
          type: 'funding',
          status: 'cancelled',
        });
        if (error.response?.status === 401) {
          return res.status(500).json({
            success: false,
            message: 'Invalid Paystack API key. Please contact support.',
          });
        }
        return res.status(error.response?.status || 500).json({
          success: false,
          message: error.response?.data?.message || 'Failed to create customer profile. Please try again.',
        });
      }

      // Create dedicated virtual account
      console.log('Creating dedicated virtual account for customer:', customerCode);
      try {
        let accountResponse;
        if (process.env.NODE_ENV === 'production') {
          for (const bank of FALLBACK_BANKS) {
            try {
              accountResponse = await axios.post(
                'https://api.paystack.co/dedicated_account',
                {
                  customer: customerCode,
                  preferred_bank: bank,
                },
                {
                  headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                  },
                }
              );

              if (accountResponse.data.status) {
                console.log(`Successfully created virtual account with bank: ${bank}`);
                break;
              }
            } catch (bankError) {
              console.warn(`Failed to create virtual account with bank ${bank}:`, {
                message: bankError.message,
                response: bankError.response?.data,
                status: bankError.response?.status,
              });
              if (bank === FALLBACK_BANKS[FALLBACK_BANKS.length - 1]) {
                throw new Error('All fallback banks failed to create virtual account');
              }
              continue;
            }
          }
        } else {
          accountResponse = await axios.post(
            'https://api.paystack.co/dedicated_account',
            {
              customer: customerCode,
            },
            {
              headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );
        }

        if (!accountResponse.data.status) {
          console.error('Failed to create virtual account:', accountResponse.data);
          throw new Error(accountResponse.data.message || 'Failed to create virtual account');
        }

        virtualAccount = {
          account_name: accountResponse.data.data.account_name,
          account_number: accountResponse.data.data.account_number,
          bank_name: accountResponse.data.data.bank.name,
          provider: 'Paystack',
          provider_reference: accountResponse.data.data.id,
          dedicated_reference: accountResponse.data.data.dedicated_account?.assignment?.integration_reference || null, // Store Paystack reference
        };

        wallet.virtualAccount = virtualAccount;
        await wallet.save();
        console.log('Virtual account saved to wallet:', virtualAccount);


        // Use dedicated reference if available, else generate custom
        const reference = virtualAccount.dedicated_reference || `FUND_${userId}_${uuidv4()}`;
        console.log('Using reference:', reference);
      } catch (error) {
        console.error('Error creating virtual account:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
        });
        await Notification.create({
          userId,
          title: 'Funding Request Failed',
          message: 'Unable to create virtual account for funding. Please try again later or contact support.',
          transactionId: `FUND_${Date.now()}`,
          type: 'funding',
          status: 'cancelled',
        });
        if (error.response?.status === 401) {
          return res.status(500).json({
            success: false,
            message: 'Invalid Paystack API key. Please contact support.',
          });
        }
        return res.status(error.response?.status || 500).json({
          success: false,
          message: error.response?.data?.message || 'Failed to create virtual account. Please try again later.',
        });
      }
    }

    // Initiate funding transaction
    const reference = `FUND_${userId}_${uuidv4()}`;
    console.log('Initiating Paystack transaction with reference:', reference);
    const fundingResponse = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        amount: amount * 100, // Paystack expects amount in kobo
        email,
        reference,
        channels: ['bank_transfer'],
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!fundingResponse.data.status) {
      console.error('Paystack transaction initialization failed:', fundingResponse.data);
      throw new Error(fundingResponse.data.message || 'Failed to initiate funding');
    }

    const fundingData = fundingResponse.data.data;
    console.log('Paystack transaction initialized:', fundingData);

    // Save transaction to wallet
    wallet.transactions.push({
      type: 'deposit',
      amount,
      reference,
      status: 'pending',
      metadata: {
        paymentGateway: 'Paystack',
        customerEmail: email,
      },
      createdAt: new Date(),
    });
    await wallet.save();
    console.log('Transaction saved to wallet:', reference);

    // Create notification
    await Notification.create({
      userId,
      title: 'Funding Request Initiated',
      message: `Funding request of ₦${amount} initiated. Please complete the bank transfer.`,
      transactionId: reference,
      type: 'funding',
      status: 'pending',
    });
    console.log('Funding notification created:', reference);

    return res.status(200).json({
      success: true,
      data: {
        virtualAccount,
        reference,
        amount,
      },
    });
  } catch (error) {
    console.error('Error in initiateFunding:', {
      userId: req.user?.id || 'unknown',
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      stack: error.stack,
    });
    await Notification.create({
      userId: req.user?.id || 'unknown',
      title: 'Funding Request Error',
      message: 'An unexpected error occurred while initiating funding. Please try again.',
      transactionId: `FUND_${Date.now()}`,
      type: 'funding',
      status: 'cancelled',
    });
    if (error.response?.status === 401) {
      return res.status(500).json({
        success: false,
        message: 'Invalid Paystack API key. Please contact support.',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Unable to initiate funding. Please try again.',
    });
  }
};

// Update other Paystack-dependent functions to use PAYSTACK_SECRET_KEY
exports.verifyFunding = async (req, res) => {
  try {
    // Log webhook receipt with detailed metadata
    console.log('Webhook received:', {
      timestamp: new Date().toISOString(),
      headers: req.headers,
      body: JSON.stringify(req.body, null, 2),
      remoteAddress: req.ip,
      url: req.originalUrl,
      method: req.method,
    });


    const webhookData = req.body;
    const { event, data } = webhookData;

    // Handle only relevant Paystack events
    if (!['dedicatedaccount.credit', 'charge.success'].includes(event)) {
      console.log('Ignoring webhook event:', { event, reference: data?.reference });
      return res.status(200).json({ status: 'success' });
    }

    // Validate webhook payload
    const { reference, amount, status, customer } = data;
    if (!reference || !amount || !status || !customer?.email) {
      console.error('Invalid webhook payload:', {
        reference,
        amount,
        status,
        customerEmail: customer?.email,
        webhookData,
      });
      return res.status(400).json({ success: false, error: 'Missing required fields in webhook payload' });
    }

    // Find wallet by reference or user email
    let wallet = await Wallet.findOne({ 'transactions.reference': reference });
    if (!wallet) {
      const user = await User.findOne({ email: customer.email });
      if (user) {
        wallet = await Wallet.findOne({ userId: user._id }) || new Wallet({
          userId: user._id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
        });
        await wallet.save();
        console.log('Wallet created or fetched for webhook:', { userId: user._id, walletId: wallet._id });
      } else {
        console.error('No user found for webhook email:', { email: customer.email, reference });
        return res.status(404).json({ success: false, error: 'User not found for webhook email' });
      }
    }

    // Check for existing transaction to ensure idempotency
    let transaction = wallet.transactions.find((t) => t.reference === reference);
    if (transaction && transaction.status === 'completed') {
      console.log('Duplicate webhook ignored (already completed):', { reference, walletId: wallet._id });
      return res.status(200).json({ status: 'success' });
    }

    // Create new transaction if none exists
    if (!transaction) {
      transaction = {
        type: 'deposit',
        amount: parseFloat(amount) / 100, // Convert kobo to NGN
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'Paystack',
          customerEmail: customer.email,
          webhookEvent: event,
        },
        createdAt: new Date(),
      };
      wallet.transactions.push(transaction);
    }

    // Update transaction status
    transaction.status = status === 'success' ? 'completed' : 'failed';
    let notification;

    if (status === 'success') {
      const amountInNaira = parseFloat(amount) / 100;
      wallet.balance += amountInNaira;
      wallet.totalDeposits += amountInNaira;

      notification = {
        userId: wallet.userId,
        title: 'Wallet Funded Successfully',
        message: `Your wallet has been funded with ${amountInNaira} NGN. Reference: ${reference}.`,
        transactionId: reference,
        type: 'funding',
        status: 'completed',
      };

      console.log('Balance updated:', {
        reference,
        amount: amountInNaira,
        newBalance: wallet.balance,
        walletId: wallet._id,
      });
    } else {
      notification = {
        userId: wallet.userId,
        title: 'Wallet Funding Failed',
        message: `Funding of ${amount / 100} NGN failed. Reference: ${reference}.`,
        transactionId: reference,
        type: 'funding',
        status: 'failed',
      };

      console.log('Funding failed:', { reference, walletId: wallet._id });
    }

    // Save wallet with retry logic for MongoDB
    let saveAttempts = 0;
    const maxSaveAttempts = 3;
    while (saveAttempts < maxSaveAttempts) {
      try {
        await wallet.recalculateBalance();
        await wallet.save();
        console.log('Wallet saved successfully:', { walletId: wallet._id, balance: wallet.balance, reference });
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
          console.error('Max save attempts reached, aborting:', { reference, walletId: wallet._id });
          return res.status(500).json({ success: false, error: 'Failed to save wallet after webhook processing' });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * saveAttempts)); // Exponential backoff
      }
    }

    // Save notification with retry logic
    saveAttempts = 0;
    while (saveAttempts < maxSaveAttempts) {
      try {
        await Notification.create(notification);
        console.log('Notification created:', { reference, userId: wallet.userId, status: notification.status });
        break;
      } catch (notifError) {
        saveAttempts++;
        console.error('Notification save attempt failed:', {
          attempt: saveAttempts,
          reference,
          message: notifError.message,
          stack: notifError.stack,
        });
        if (saveAttempts === maxSaveAttempts) {
          console.warn('Max notification save attempts reached, continuing without notification:', { reference });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * saveAttempts));
      }
    }

    // Emit WebSocket update
    const io = req.app.get('io');
    if (io) {
      io.to(wallet.userId.toString()).emit('balanceUpdate', {
        balance: wallet.balance,
        transaction: {
          amount: parseFloat(amount) / 100,
          reference,
          status: transaction.status,
        },
      });
      console.log('WebSocket balance update emitted:', { userId: wallet.userId, reference });
    } else {
      console.warn('Socket.io instance not found for webhook:', { reference });
    }

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Webhook processing error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      headers: req.headers,
    });
    return res.status(500).json({ success: false, error: 'Internal server error during webhook processing' });
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
      console.warn('No reference provided for funding status check');
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    console.log('Checking funding status for reference:', reference);

    let wallet = await Wallet.findOne({ userId: req.user.id });
    if (!wallet) {
      console.warn('Wallet not found during funding status check, recreating:', req.user.id);
      wallet = new Wallet({
        userId: req.user.id,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet recreated for funding status check:', { userId: req.user.id, walletId: wallet._id });
    }

    let transaction = wallet.transactions.find((t) => t.reference === reference);
    if (!transaction) {
      console.log('Transaction not found locally, checking Paystack:', reference);
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

        console.log('Paystack API response:', JSON.stringify(response.data, null, 2));

        if (response.data.status && response.data.data?.status === 'success') {
          const { amount, reference: paymentReference, customer } = response.data.data;
          transaction = {
            type: 'deposit',
            amount: parseFloat(amount) / 100,
            reference: paymentReference,
            status: 'completed',
            metadata: {
              paymentGateway: 'Paystack',
              paymentReference,
              customerEmail: customer.email,
            },
            createdAt: new Date(),
          };

          wallet.transactions.push(transaction);
          wallet.balance += parseFloat(amount) / 100;
          wallet.totalDeposits += parseFloat(amount) / 100;
          await wallet.recalculateBalance();
          await wallet.save();

          await Notification.create({
            userId: wallet.userId,
            title: 'Wallet Funded Successfully',
            message: `Your wallet has been funded with ${(amount / 100)} NGN. Transaction reference: ${reference}.`,
            transactionId: reference,
            type: 'funding',
            status: 'completed',
          });
          console.log('Success notification created for checkFundingStatus:', {
            userId: wallet.userId,
            reference,
            amount: amount / 100,
          });

          const io = req.app.get('io');
          if (io) {
            io.to(wallet.userId.toString()).emit('balanceUpdate', {
              balance: wallet.balance,
              transaction: {
                amount: parseFloat(amount) / 100,
                reference,
                status: 'completed',
              },
            });
            console.log('WebSocket balance update emitted to:', wallet.userId);
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
          console.log('Paystack verification failed or pending:', response.data);
          return res.status(200).json({
            success: true,
            message: 'Payment not confirmed',
            data: { status: response.data.data?.status || 'pending' },
          });
        }
      } catch (error) {
        console.error('Paystack API error:', {
          reference,
          message: error.message,
          code: error.code,
          response: error.response?.data,
          status: error.response?.status,
        });
        let errorMessage = 'Failed to verify transaction with Paystack';
        if (error.code === 'ECONNABORTED') {
          errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
        } else if (error.response?.status === 401) {
          errorMessage = 'Invalid Paystack API key. Please contact support.';
        } else if (error.response?.status === 429) {
          errorMessage = 'Too many requests to the payment provider. Please try again later.';
        } else if (error.response?.status === 500) {
          errorMessage = 'Payment provider encountered an internal server error. Please try again later or contact support.';
        } else if (error.response?.status === 404) {
          errorMessage = 'Transaction not found in Paystack';
        }
        return res.status(error.response?.status === 404 ? 404 : 502).json({
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

    // Fixed message logic
    let message;
    if (transaction.status === 'completed') {
      message = 'Payment confirmed';
    } else if (transaction.status === 'failed') {
      message = 'Payment failed';
    } else {
      message = 'Payment pending';
    }

    return res.status(200).json({
      success: true,
      message,
      data: {
        transaction,
        newBalance: wallet.balance,
      },
    });
  } catch (error) {
    console.error('Check funding status error:', {
      reference: req.params.reference,
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
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