const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Configure axios retries
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000, // 1s, 2s, 3s
  retryCondition: (error) => {
    return error.code === 'ECONNABORTED' || error.response?.status >= 500;
  },
});

// Get wallet balance
exports.getWalletBalance = async (req, res) => {
  try {
    console.log('Fetching wallet balance for user:', req.user.id);
    const wallet = await Wallet.findOne({ userId: req.user.id });
    if (!wallet) {
      console.warn('Wallet not found for user:', req.user.id);
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    await wallet.recalculateBalance();

    res.status(200).json({
      success: true,
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
      currency: wallet.currency,
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

// Initiate funding
exports.initiateFunding = async (req, res) => {
  try {
    const { amount, email, phoneNumber } = req.body;
    const userId = req.user.id;

    console.log('Initiate funding request:', { userId, amount, email, phoneNumber });

    if (!amount || amount <= 0) {
      console.warn('Invalid amount provided:', amount);
      return res.status(400).json({ success: false, error: 'Valid amount is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.warn('User not found:', userId);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      console.warn('Wallet not found for user:', userId);
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const reference = `WF-${userId.toString().slice(-6)}-${Date.now()}`;

    const paymentRequest = {
      email: email || user.email,
      name: user.firstName ? `${user.firstName} ${user.lastName || ''}` : user.email.split('@')[0],
      phoneNumber: phoneNumber || user.phoneNumber || '00000000000',
      bankCode: ['20946'], // Palmpay
      businessId: process.env.PAYMENT_POINT_BUSINESS_ID,
      metadata: {
        userId: userId.toString(),
        walletId: wallet._id.toString(),
        type: 'wallet_funding',
        amount: amount.toString(),
        reference,
        callback_url: `${process.env.BASE_URL}/api/wallet/verify-funding`,
      },
    };

    const headers = {
      Authorization: `Bearer ${process.env.PAYMENT_POINT_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'api-key': process.env.PAYMENT_POINT_PUBLIC_KEY,
    };

    const url = `${process.env.PAYMENT_POINT_API_URL}/api/v1/createVirtualAccount`;
    console.log('Initiating virtual account:', {
      url,
      headers: { ...headers, Authorization: 'Bearer [REDACTED]' },
      body: paymentRequest,
    });

    let response;
    try {
      response = await axios.post(url, paymentRequest, { headers, timeout: 10000 });
    } catch (error) {
      console.error('PaymentPoint API error:', {
        endpoint: url,
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        code: error.code,
      });
      return res.status(502).json({
        success: false,
        message: 'Failed to initiate virtual account',
        error: error.response?.data?.message || error.message,
      });
    }

    console.log('PaymentPoint response:', response.data);

    if (response.data?.status === 'success') {
      const transaction = {
        type: 'deposit',
        amount: parseFloat(amount),
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'PaymentPoint',
          virtualAccountId: response.data.customer.customer_id,
          accountNumber: response.data.bankAccounts[0].accountNumber,
          paymentReference: reference,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);
      try {
        await wallet.save();
        console.log('Transaction saved:', { reference, walletId: wallet._id });
      } catch (error) {
        console.error('Wallet save error:', {
          walletId: wallet._id,
          reference,
          message: error.message,
          stack: error.stack,
        });
        return res.status(500).json({
          success: false,
          message: 'Failed to save transaction',
          error: error.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Virtual account created for funding',
        data: {
          virtualAccount: {
            accountNumber: response.data.bankAccounts[0].accountNumber,
            accountName: response.data.bankAccounts[0].accountName,
            bankName: response.data.bankAccounts[0].bankName,
          },
          reference,
        },
      });
    }

    console.warn('PaymentPoint API returned non-success status:', response.data);
    return res.status(400).json({
      success: false,
      message: 'Failed to create virtual account',
      error: response.data.message || 'Unknown error',
    });
  } catch (error) {
    console.error('Payment initialization error:', {
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

// Verify wallet funding (webhook handler)
exports.verifyFunding = async (req, res) => {
  try {
    // Log the raw body and headers for debugging
    console.log('Webhook received:', {
      headers: req.headers,
      body: req.body.toString('utf8'),
      timestamp: new Date().toISOString(),
    });

    const signature = req.headers['paymentpoint-signature'];
    const payload = req.body.toString('utf8');

    if (signature) {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.PAYMENT_POINT_SECRET_KEY)
        .update(payload)
        .digest('hex');
      console.log('Signature verification:', {
        received: signature,
        expected: expectedSignature,
        secretKeyUsed: process.env.PAYMENT_POINT_SECRET_KEY.substring(0, 4) + '...',
        payloadLength: payload.length,
        payloadSample: payload.substring(0, 100) + '...',
      });

      if (signature !== expectedSignature) {
        console.error('Webhook signature verification failed:', {
          received: signature,
          expected: expectedSignature,
          payload: payload,
        });
        return res.status(400).json({ success: false, error: 'Invalid signature' });
      }
    } else {
      console.warn('No signature provided in webhook');
      return res.status(400).json({ success: false, error: 'Signature required' });
    }

    // Parse the raw body to JSON for processing
    const webhookData = JSON.parse(payload);

    const {
      transaction_id,
      transaction_status,
      amount_paid,
      customer: { customer_id },
      description,
    } = webhookData;

    if (!transaction_id || !transaction_status || !amount_paid || !customer_id) {
      console.error('Invalid webhook payload:', webhookData);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields in webhook payload',
      });
    }

    let wallet = await Wallet.findOne({
      'transactions.metadata.virtualAccountId': customer_id,
    });

    if (!wallet) {
      console.error('Wallet not found for customer_id:', customer_id);
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    // Match transaction by virtualAccountId, amount, and pending status
    let transactionIndex = wallet.transactions.findIndex(
      (t) =>
        t.metadata.virtualAccountId === customer_id &&
        t.status === 'pending' &&
        parseFloat(t.amount) === parseFloat(amount_paid)
    );

    if (transactionIndex === -1) {
      console.warn('No matching pending transaction found for customer_id and amount:', {
        customer_id,
        amount_paid,
      });
      const newReference = `WF-${wallet.userId.toString().slice(-6)}-${Date.now()}`;
      wallet.transactions.push({
        type: 'deposit',
        amount: parseFloat(amount_paid),
        reference: newReference,
        status: transaction_status === 'success' ? 'completed' : 'failed',
        metadata: {
          paymentGateway: 'PaymentPoint',
          virtualAccountId: customer_id,
          paymentId: transaction_id,
          description,
        },
        createdAt: new Date(),
      });
      transactionIndex = wallet.transactions.length - 1;
    }

    const transaction = wallet.transactions[transactionIndex];
    transaction.status = transaction_status === 'success' ? 'completed' : 'failed';
    transaction.metadata.paymentId = transaction_id;
    transaction.metadata.description = description;

    if (transaction_status === 'success') {
      const amountInNaira = parseFloat(amount_paid);
      if (!isNaN(amountInNaira)) {
        wallet.balance += amountInNaira;
        wallet.totalDeposits += amountInNaira;
        console.log('Balance updated:', {
          reference: transaction.reference,
          amount: amountInNaira,
          newBalance: wallet.balance,
          totalDeposits: wallet.totalDeposits,
        });
      } else {
        console.error('Invalid amount:', amount_paid);
      }
    }

    await wallet.recalculateBalance();
    await wallet.save();

    console.log('Wallet saved:', {
      walletId: wallet._id,
      transactionStatus: transaction_status,
      balance: wallet.balance,
    });

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Webhook error:', {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Handle direct verification of funding (for frontend callback)
exports.checkFundingStatus = async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) {
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    const wallet = await Wallet.findOne({ userId: req.user.id });
    if (!wallet) {
      console.warn('Wallet not found for user:', req.user.id);
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    let transaction = wallet.transactions.find((t) => t.reference === reference);
    if (!transaction) {
      console.log('Transaction not found locally, checking PaymentPoint:', reference);
      const headers = {
        Authorization: `Bearer ${process.env.PAYMENT_POINT_SECRET_KEY}`,
        'api-key': process.env.PAYMENT_POINT_PUBLIC_KEY,
        'Content-Type': 'application/json',
      };

      try {
        const response = await axios.get(
          `${process.env.PAYMENT_POINT_API_URL}/api/v1/verifyTransactionByReference/${reference}`,
          {
            headers,
            timeout: 10000,
          }
        );

        console.log('PaymentPoint API response:', response.data);

        if (response.data?.status === 'success' && response.data.data?.status === 'success') {
          const { amount, id, customer_id } = response.data.data;
          transaction = {
            type: 'deposit',
            amount: parseFloat(amount),
            reference,
            status: 'completed',
            metadata: {
              paymentGateway: 'PaymentPoint',
              paymentId: id,
              paymentReference: reference,
              virtualAccountId: customer_id,
            },
            createdAt: new Date(),
          };

          wallet.transactions.push(transaction);
          wallet.balance += parseFloat(amount);
          wallet.totalDeposits += parseFloat(amount);
          await wallet.save();

          console.log('Transaction verified via API:', {
            reference,
            amount,
            newBalance: wallet.balance,
          });
        } else {
          console.log('PaymentPoint verification failed:', response.data);
          return res.status(200).json({
            success: false,
            message: 'Payment not confirmed',
            data: { status: response.data.data?.status || 'pending' },
          });
        }
      } catch (error) {
        console.error('PaymentPoint API error:', {
          reference,
          message: error.message,
          code: error.code,
          response: error.response?.data,
          status: error.response?.status,
        });
        if (error.response?.status === 404) {
          return res.status(404).json({
            success: false,
            message: 'Transaction not found in PaymentPoint',
          });
        }
        return res.status(502).json({
          success: false,
          error: 'Failed to verify transaction with PaymentPoint',
          details: error.response?.data?.message || error.message,
        });
      }
    }

    if (transaction.status === 'completed') {
      await wallet.recalculateBalance();
    }

    return res.status(200).json({
      success: transaction.status === 'completed',
      message:
        transaction.status === 'completed'
          ? 'Payment confirmed'
          : 'Payment pending or failed',
      data: {
        transaction,
        newBalance: wallet.balance,
      },
    });
  } catch (error) {
    console.error('Check funding status error:', {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Reconcile pending transactions
exports.reconcileTransactions = async (req, res) => {
  try {
    console.log('Starting transaction reconciliation');
    const wallets = await Wallet.find({
      'transactions.status': 'pending',
    });

    for (const wallet of wallets) {
      for (const tx of wallet.transactions.filter((t) => t.status === 'pending')) {
        try {
          const response = await axios.get(
            `${process.env.PAYMENT_POINT_API_URL}/api/v1/verifyTransactionByReference/${tx.reference}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYMENT_POINT_SECRET_KEY}`,
                'api-key': process.env.PAYMENT_POINT_PUBLIC_KEY,
                'Content-Type': 'application/json',
              },
              timeout: 10000,
            }
          );

          console.log('Reconciliation: PaymentPoint response for', tx.reference, response.data);

          if (response.data?.status === 'success' && response.data.data?.status === 'success') {
            tx.status = 'completed';
            wallet.balance += parseFloat(response.data.data.amount);
            wallet.totalDeposits += parseFloat(response.data.data.amount);
            await wallet.recalculateBalance();
            await wallet.save();
            console.log('Manual reconciliation: Transaction completed:', tx.reference);
          } else if (response.data.data?.status === 'failed') {
            tx.status = 'failed';
            await wallet.save();
            console.log('Manual reconciliation: Transaction failed:', tx.reference);
          }
        } catch (error) {
          console.error('Manual reconciliation error:', {
            reference: tx.reference,
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
          });
          if (error.response?.status === 404) {
            console.warn('Transaction not found in PaymentPoint, marking as failed:', tx.reference);
            tx.status = 'failed';
            await wallet.save();
          }
        }
      }
    }

    if (res) {
      return res.status(200).json({ success: true, message: 'Transaction reconciliation completed' });
    }
  } catch (error) {
    console.error('Reconciliation error:', {
      message: error.message,
      stack: error.stack,
    });
    if (res) {
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
};