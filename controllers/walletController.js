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

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (!email || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'Email and phone number are required' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Find or create wallet
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
        virtualAccount: null,
      });
      await wallet.save();
    }

    let virtualAccount = wallet.virtualAccount;
    let customerCode;

    // Create or fetch Paystack customer
    if (!virtualAccount) {
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
          throw new Error(customerResponse.data.message || 'Failed to create customer');
        }

        customerCode = customerResponse.data.data.customer_code;
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
      try {
        let accountResponse;
        if (process.env.NODE_ENV === 'production') {
          // In production, try each fallback bank
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
          // In test mode, omit preferred_bank to let Paystack assign a default test bank
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
          throw new Error(accountResponse.data.message || 'Failed to create virtual account');
        }

        virtualAccount = {
          account_name: accountResponse.data.data.account_name,
          account_number: accountResponse.data.data.account_number,
          bank_name: accountResponse.data.data.bank.name,
          provider: 'Paystack',
          provider_reference: accountResponse.data.data.id,
        };

        wallet.virtualAccount = virtualAccount;
        await wallet.save();
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
      throw new Error(fundingResponse.data.message || 'Failed to initiate funding');
    }

    const fundingData = fundingResponse.data.data;

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

    // Create notification
    await Notification.create({
      userId,
      title: 'Funding Request Initiated',
      message: `Funding request of ₦${amount} initiated. Please complete the bank transfer.`,
      transactionId: reference,
      type: 'funding',
      status: 'pending',
    });

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
      userId: req.user.id,
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });
    await Notification.create({
      userId: req.user.id,
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
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || 'Unable to initiate funding. Please try again.',
    });
  }
};

// Update other Paystack-dependent functions to use PAYSTACK_SECRET_KEY
exports.verifyFunding = async (req, res) => {
  try {
    console.log('Webhook received:', {
      headers: req.headers,
      body: req.body,
      timestamp: new Date().toISOString(),
    });

    // Verify Paystack webhook signature
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      console.error('Invalid Paystack webhook signature');
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
    }

    const webhookData = req.body;
    console.log('Parsed webhook data:', JSON.stringify(webhookData, null, 2));

    const { event, data } = webhookData;
    if (event !== 'dedicatedaccount.credit') {
      console.log('Ignoring non-credit webhook event:', event);
      return res.status(200).json({ status: 'success' });
    }

    const { reference, amount, status, customer } = data;
    if (!reference || !amount || !status || !customer?.email) {
      console.error('Invalid webhook payload:', webhookData);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields in webhook payload',
      });
    }

    let wallet = await Wallet.findOne({
      'transactions.reference': reference,
    });

    if (!wallet) {
      console.warn('Wallet not found for reference:', reference);
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    console.log('Wallet found:', {
      walletId: wallet._id,
      userId: wallet.userId,
      reference,
    });

    let transactionIndex = wallet.transactions.findIndex(
      (t) => t.reference === reference && t.status === 'pending'
    );

    if (transactionIndex === -1) {
      console.warn('No matching pending transaction found, creating new transaction:', reference);
      const newTransaction = {
        type: 'deposit',
        amount: parseFloat(amount) / 100,
        reference,
        status: status === 'success' ? 'completed' : 'failed',
        metadata: {
          paymentGateway: 'Paystack',
          paymentReference: reference,
          customerEmail: customer.email,
        },
        createdAt: new Date(),
      };
      wallet.transactions.push(newTransaction);
      transactionIndex = wallet.transactions.length - 1;
    }

    const transaction = wallet.transactions[transactionIndex];
    console.log('Transaction before update:', {
      reference: transaction.reference,
      status: transaction.status,
      amount: transaction.amount,
      metadata: transaction.metadata,
    });

    if (transaction.status === 'completed') {
      console.log('Transaction already completed:', transaction.reference);
      return res.status(200).json({ status: 'success' });
    }

    transaction.status = status === 'success' ? 'completed' : 'failed';
    transaction.metadata.customerEmail = customer.email;

    if (status === 'success') {
      const amountInNaira = parseFloat(amount) / 100;
      if (!isNaN(amountInNaira)) {
        wallet.balance += amountInNaira;
        wallet.totalDeposits += amountInNaira;
        console.log('Balance updated:', {
          reference: transaction.reference,
          amount: amountInNaira,
          newBalance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
        });

        const notification = new Notification({
          userId: wallet.userId,
          title: 'Wallet Funded Successfully',
          message: `Your wallet has been funded with ${amountInNaira} NGN. Transaction reference: ${transaction.reference}.`,
          transactionId: transaction.reference,
          type: 'funding',
          status: 'completed',
        });
        await notification.save();
        console.log('Success notification created:', {
          userId: wallet.userId,
          reference: transaction.reference,
          amount: amountInNaira,
        });
      } else {
        console.error('Invalid amount in webhook:', amount);
      }
    } else {
      const notification = new Notification({
        userId: wallet.userId,
        title: 'Wallet Funding Failed',
        message: `Your wallet funding of ${(amount / 100)} NGN failed. Transaction reference: ${transaction.reference}.`,
        transactionId: transaction.reference,
        type: 'funding',
        status: 'failed',
      });
      await notification.save();
      console.log('Failure notification created:', {
        userId: wallet.userId,
        reference: transaction.reference,
        amount: amount / 100,
      });
    }

    await wallet.recalculateBalance();
    await wallet.save();
    console.log('Wallet saved successfully:', {
      walletId: wallet._id,
      transactionStatus: status,
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
      transactionReference: transaction.reference,
    });

    const io = req.app.get('io');
    io.to(wallet.userId.toString()).emit('balanceUpdate', {
      balance: wallet.balance,
      transaction: {
        amount: parseFloat(amount) / 100,
        reference: transaction.reference,
      },
    });

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Webhook processing error:', {
      message: error.message,
      stack: error.stack,
      headers: req.headers,
      body: req.body,
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
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

          const notification = new Notification({
            userId: wallet.userId,
            title: 'Wallet Funded Successfully',
            message: `Your wallet has been funded with ${(amount / 100)} NGN. Transaction reference: ${reference}.`,
            transactionId: reference,
            type: 'funding',
            status: 'completed',
          });
          await notification.save();
          console.log('Success notification created for checkFundingStatus:', {
            userId: wallet.userId,
            reference,
            amount: amount / 100,
          });

          console.log('Transaction verified via API:', {
            reference,
            amount: amount / 100,
            newBalance: wallet.balance,
          });
        } else {
          console.log('Paystack verification failed or pending:', response.data);
          return res.status(200).json({
            success: true, // Changed to true for valid response
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

    return res.status(200).json({
      success: true, // Changed to true for valid response
      message:
        transaction.status === 'completed'
          ? 'Payment confirmed'
          : transaction.status === 'failed'
          ? 'Payment failed'
          : 'Payment pending',
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