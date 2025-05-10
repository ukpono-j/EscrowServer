const Wallet = require('../modules/wallet');
const User = require('../modules/Users');
const Notification = require('../modules/Notification'); // Add Notification model
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    console.log(`Retry attempt ${retryCount} for PaymentPoint API at ${new Date().toISOString()}`);
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

    console.log('Initiate funding request:', { userId, amount, email, phoneNumber });

    if (!amount || isNaN(amount) || amount <= 0) {
      console.warn('Invalid amount provided:', amount);
      return res.status(400).json({ success: false, error: 'Valid amount is required' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.warn('Invalid email provided:', email);
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    if (!phoneNumber || !/^\d{10,11}$/.test(phoneNumber)) {
      console.warn('Invalid phone number provided:', phoneNumber);
      return res.status(400).json({ success: false, error: 'Valid phone number (10-11 digits) is required' });
    }

    const requiredEnvVars = [
      'PAYMENT_POINT_API_URL',
      'PAYMENT_POINT_SECRET_KEY',
      'PAYMENT_POINT_PUBLIC_KEY',
      'PAYMENT_POINT_BUSINESS_ID',
      'BASE_URL',
    ];
    const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
    if (missingEnvVars.length > 0) {
      console.error('Missing environment variables:', missingEnvVars);
      return res.status(500).json({
        success: false,
        error: 'Server configuration error. Please contact support.',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.warn('User not found:', userId);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      console.warn('Wallet not found during funding, recreating:', userId);
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
      console.log('Wallet recreated for funding:', { userId, walletId: wallet._id });
    }

    const reference = `WF-${crypto.randomBytes(4).toString('hex')}-${Date.now()}`;
    console.log('Generated transaction reference:', reference);

    const existingTransaction = wallet.transactions.find((t) => t.reference === reference);
    if (existingTransaction) {
      console.error('Duplicate reference generated:', reference);
      return res.status(500).json({ success: false, error: 'Internal server error: Duplicate reference' });
    }

    const paymentRequest = {
      email: email || user.email,
      name: user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : user.email.split('@')[0],
      phoneNumber: phoneNumber || user.phoneNumber || '00000000000',
      bankCode: ['20946'],
      businessId: process.env.PAYMENT_POINT_BUSINESS_ID,
      externalId: userId.toString(),
      metadata: {
        userId: userId.toString(),
        walletId: wallet._id.toString(),
        type: 'wallet_funding',
        amount: amount.toString(),
        reference,
        callback_url: `${process.env.BASE_URL}/api/wallet/verify-funding`,
      },
    };

    console.log('PaymentPoint API payload:', JSON.stringify(paymentRequest, null, 2));

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
      response = await axios.post(url, paymentRequest, {
        headers,
        timeout: 15000,
      });
      console.log('PaymentPoint full response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
      console.error('PaymentPoint API error:', {
        endpoint: url,
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        code: error.code,
      });

      let errorMessage = 'Failed to initiate virtual account';
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
      } else if (error.response?.status === 401) {
        errorMessage = 'Invalid API credentials. Please contact support.';
      } else if (error.response?.status === 429) {
        errorMessage = 'Too many requests to the payment provider. Please try again later.';
      } else if (error.response?.status === 500) {
        errorMessage = 'Payment provider encountered an internal server error. Please try again later or contact support.';
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      }

      const transaction = {
        type: 'deposit',
        amount: parseFloat(amount),
        reference,
        status: 'failed',
        metadata: {
          paymentGateway: 'PaymentPoint',
          error: errorMessage,
          errorDetails: error.response?.data || error.message,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);

      // Create notification for failed funding attempt
      const notification = new Notification({
        userId,
        title: 'Wallet Funding Failed',
        message: `Your attempt to fund your wallet with ${amount} NGN failed: ${errorMessage}`,
        transactionId: reference,
        type: 'funding',
        status: 'failed',
      });
      await notification.save();
      console.log('Failure notification created:', { userId, reference, errorMessage });

      await wallet.save();
      console.log('Failed transaction saved:', { reference, walletId: wallet._id });

      return res.status(502).json({
        success: false,
        message: errorMessage,
        error: error.message,
      });
    }

    if (response.data?.status === 'success') {
      const bankAccount = response.data.bankAccounts[0];
      if (!bankAccount || !bankAccount.accountNumber || !bankAccount.accountName || !bankAccount.bankName) {
        console.error('Invalid virtual account details:', response.data);

        // Create notification for invalid virtual account
        const notification = new Notification({
          userId,
          title: 'Wallet Funding Error',
          message: 'Failed to create virtual account for funding. Please try again or contact support.',
          transactionId: reference,
          type: 'funding',
          status: 'failed',
        });
        await notification.save();
        console.log('Error notification created:', { userId, reference });

        return res.status(502).json({
          success: false,
          message: 'Invalid virtual account details returned by PaymentPoint',
        });
      }

      const transaction = {
        type: 'deposit',
        amount: parseFloat(amount),
        reference,
        status: 'pending',
        metadata: {
          paymentGateway: 'PaymentPoint',
          virtualAccountId: response.data.customer.customer_id,
          accountNumber: bankAccount.accountNumber,
          paymentReference: reference,
        },
        createdAt: new Date(),
      };

      wallet.transactions.push(transaction);

      // Create notification for funding initiation
      const notification = new Notification({
        userId,
        title: 'Wallet Funding Initiated',
        message: `A virtual account has been created to fund your wallet with ${amount} NGN. Please transfer to ${bankAccount.accountName}, ${bankAccount.accountNumber} (${bankAccount.bankName}).`,
        transactionId: reference,
        type: 'funding',
        status: 'pending',
      });
      await notification.save();
      console.log('Funding initiation notification created:', { userId, reference });

      await wallet.save();
      console.log('Transaction saved:', { reference, walletId: wallet._id });

      return res.status(200).json({
        success: true,
        message: 'Virtual account created for funding',
        data: {
          virtualAccount: {
            accountNumber: bankAccount.accountNumber,
            accountName: bankAccount.accountName,
            bankName: bankAccount.bankName,
          },
          reference,
        },
      });
    }

    console.warn('PaymentPoint API returned non-success status:', response.data);

    // Create notification for non-success response
    const notification = new Notification({
      userId,
      title: 'Wallet Funding Error',
      message: 'Failed to create virtual account for funding. Please try again.',
      transactionId: reference,
      type: 'funding',
      status: 'failed',
    });
    await notification.save();
    console.log('Error notification created:', { userId, reference });

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

    // Create notification for general error
    const notification = new Notification({
      userId,
      title: 'Wallet Funding Error',
      message: 'An error occurred while initiating wallet funding. Please try again or contact support.',
      transactionId: `WF-ERROR-${Date.now()}`,
      type: 'funding',
      status: 'failed',
    });
    await notification.save();
    console.log('General error notification created:', { userId });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

exports.verifyFunding = async (req, res) => {
  try {
    console.log('Webhook received:', {
      headers: req.headers,
      body: req.body.toString('utf8'),
      timestamp: new Date().toISOString(),
    });

    const signature = req.headers['paymentpoint-signature'];
    const payload = req.body.toString('utf8');

    if (!signature) {
      console.warn('No signature provided in webhook');
      return res.status(400).json({ success: false, error: 'Signature required' });
    }

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

    let webhookData;
    try {
      webhookData = JSON.parse(payload);
    } catch (error) {
      console.error('Failed to parse webhook payload:', {
        error: error.message,
        payload: payload,
      });
      return res.status(400).json({ success: false, error: 'Invalid payload format' });
    }

    console.log('Parsed webhook data:', JSON.stringify(webhookData, null, 2));

    const {
      transaction_id,
      transaction_status,
      amount_paid,
      customer: { customer_id } = {},
      description,
      transaction_reference,
    } = webhookData;

    if (!transaction_id || !transaction_status || !amount_paid || !customer_id) {
      console.error('Invalid webhook payload:', {
        transaction_id,
        transaction_status,
        amount_paid,
        customer_id,
        webhookData,
      });
      return res.status(400).json({
        success: false,
        error: 'Missing required fields in webhook payload',
      });
    }

    let wallet = await Wallet.findOne({
      $or: [
        { 'transactions.metadata.virtualAccountId': customer_id },
        { 'transactions.reference': transaction_reference },
        { 'transactions.metadata.paymentId': transaction_id },
      ],
    });

    if (!wallet) {
      console.warn('Wallet not found for customer_id, transaction_reference, or transaction_id:', {
        customer_id,
        transaction_reference,
        transaction_id,
      });
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    console.log('Wallet found:', {
      walletId: wallet._id,
      userId: wallet.userId,
      customer_id,
      transaction_reference,
      transaction_id,
    });

    let transactionIndex = wallet.transactions.findIndex(
      (t) =>
        (t.metadata.virtualAccountId === customer_id ||
         t.reference === transaction_reference ||
         t.metadata.paymentId === transaction_id) &&
        t.status === 'pending' &&
        Math.abs(parseFloat(t.amount) - parseFloat(amount_paid)) < 0.01
    );

    if (transactionIndex === -1) {
      console.warn('No matching pending transaction found, creating new transaction:', {
        customer_id,
        amount_paid,
        transaction_reference,
        transaction_id,
      });
      const newReference = transaction_reference || `WF-${wallet.userId.toString().slice(-6)}-${Date.now()}`;
      const newTransaction = {
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

        // Create notification for successful funding
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
        console.error('Invalid amount in webhook:', amount_paid);
      }
    } else {
      // Create notification for failed funding
      const notification = new Notification({
        userId: wallet.userId,
        title: 'Wallet Funding Failed',
        message: `Your wallet funding of ${amount_paid} NGN failed. Transaction reference: ${transaction.reference}.`,
        transactionId: transaction.reference,
        type: 'funding',
        status: 'failed',
      });
      await notification.save();
      console.log('Failure notification created:', {
        userId: wallet.userId,
        reference: transaction.reference,
        amount: amount_paid,
      });
    }

    await wallet.recalculateBalance();
    console.log('Balance recalculated:', {
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
    });

    await wallet.save();
    console.log('Wallet saved successfully:', {
      walletId: wallet._id,
      transactionStatus: transaction_status,
      balance: wallet.balance,
      totalDeposits: wallet.totalDeposits,
      transactionReference: transaction.reference,
    });

    // Emit socket event for balance update
    const io = req.app.get('io');
    io.to(wallet.userId.toString()).emit('balanceUpdate', {
      balance: wallet.balance,
      transaction: {
        amount: parseFloat(amount_paid),
        reference: transaction.reference,
      },
    });

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Webhook processing error:', {
      message: error.message,
      stack: error.stack,
      headers: req.headers,
      body: req.body.toString('utf8'),
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
            timeout: 15000,
          }
        );

        console.log('PaymentPoint API response:', JSON.stringify(response.data, null, 2));

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
          await wallet.recalculateBalance();
          await wallet.save();

          // Create notification for verified funding
          const notification = new Notification({
            userId: wallet.userId,
            title: 'Wallet Funded Successfully',
            message: `Your wallet has been funded with ${amount} NGN. Transaction reference: ${reference}.`,
            transactionId: reference,
            type: 'funding',
            status: 'completed',
          });
          await notification.save();
          console.log('Success notification created for checkFundingStatus:', {
            userId: wallet.userId,
            reference,
            amount,
          });

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
        let errorMessage = 'Failed to verify transaction with PaymentPoint';
        if (error.code === 'ECONNABORTED') {
          errorMessage = 'Payment provider is currently unavailable due to a timeout. Please try again later.';
        } else if (error.response?.status === 401) {
          errorMessage = 'Invalid API credentials. Please contact support.';
        } else if (error.response?.status === 429) {
          errorMessage = 'Too many requests to the payment provider. Please try again later.';
        } else if (error.response?.status === 500) {
          errorMessage = 'Payment provider encountered an internal server error. Please try again later or contact support.';
        } else if (error.response?.status === 404) {
          errorMessage = 'Transaction not found in PaymentPoint';
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
      success: transaction.status === 'completed',
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

          // Create notification for timed-out transaction
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
            `${process.env.PAYMENT_POINT_API_URL}/api/v1/verifyTransactionByReference/${tx.reference}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYMENT_POINT_SECRET_KEY}`,
                'api-key': process.env.PAYMENT_POINT_PUBLIC_KEY,
                'Content-Type': 'application/json',
              },
              timeout: 15000,
            }
          );

          console.log('Reconciliation: PaymentPoint response for', tx.reference, JSON.stringify(response.data, null, 2));

          if (response.data?.status === 'success' && response.data.data?.status === 'success') {
            tx.status = 'completed';
            wallet.balance += parseFloat(response.data.data.amount);
            wallet.totalDeposits += parseFloat(response.data.data.amount);

            // Create notification for reconciled transaction
            const notification = new Notification({
              userId: wallet.userId,
              title: 'Wallet Funded Successfully',
              message: `Your wallet has been funded with ${response.data.data.amount} NGN. Transaction reference: ${tx.reference}.`,
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
            console.log('Manual reconciliation: Transaction completed:', tx.reference);
          } else if (response.data.data?.status === 'failed') {
            tx.status = 'failed';

            // Create notification for failed reconciliation
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

            // Create notification for not found transaction
            const notification = new Notification({
              userId: wallet.userId,
              title: 'Wallet Funding Failed',
              message: `Your wallet funding of ${tx.amount} NGN was not found. Transaction reference: ${tx.reference}.`,
              transactionId: tx.reference,
              type: 'funding',
              status: 'failed',
            });
            await notification.save();
            console.log('Not found notification created:', {
              userId: wallet.userId,
              reference: tx.reference,
            });

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

exports.getWalletTransactions = async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ userId: req.user.id });
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }
    res.status(200).json({
      success: true,
      transactions: wallet.transactions,
    });
  } catch (error) {
    console.error('Get wallet transactions error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};