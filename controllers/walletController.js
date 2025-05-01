const UserModel = require('../modules/Users');
const axios = require('axios');
const crypto = require('crypto');

// Environment variables should be properly set in your .env file
const PAYMENT_POINT_SECRET_KEY = process.env.PAYMENT_POINT_SECRET_KEY;
const PAYMENT_POINT_PUBLIC_KEY = process.env.PAYMENT_POINT_PUBLIC_KEY;
const PAYMENT_POINT_API_URL = process.env.PAYMENT_POINT_API_URL || 'https://api.paymentpoint.co/api/v1';

// Get user wallet balance
exports.getWalletBalance = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const user = await UserModel.findById(userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Return wallet balance and last 5 transactions
    const walletData = {
      balance: user.wallet?.balance || 0,
      recentTransactions: user.wallet?.transactions?.slice(0, 5) || []
    };

    res.status(200).json(walletData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Get wallet transaction history
exports.getWalletTransactions = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { page = 1, limit = 10 } = req.query;
    
    const user = await UserModel.findById(userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const transactions = user.wallet?.transactions || [];
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const paginatedTransactions = transactions.slice(startIndex, endIndex);
    
    res.status(200).json({
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Initialize wallet funding
exports.initiateFunding = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount is required" });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate a unique reference
    const reference = `WF-${userId.slice(-6)}-${Date.now()}`;
    
    // Create PaymentPoint Payment Request
    try {
      const paymentRequest = {
        amount: amount * 100, // PaymentPoint requires amount in kobo
        email: user.email,
        reference: reference,
        callback_url: `${req.protocol}://${req.get('host')}/api/wallet/verify-funding`,
        metadata: {
          userId: userId,
          type: 'wallet_funding'
        }
      };

      // Make API call to PaymentPoint
      const response = await axios.post(
        `${PAYMENT_POINT_API_URL}/transaction/initialize`, 
        paymentRequest,
        {
          headers: {
            'Authorization': `Bearer ${PAYMENT_POINT_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data && response.data.status === 'success') {
        // Record pending transaction in user's wallet
        user.wallet = user.wallet || { balance: 0, transactions: [] };
        user.wallet.transactions.unshift({
          type: 'credit',
          amount: amount,
          description: 'Wallet funding',
          reference: reference,
          status: 'pending',
          timestamp: new Date()
        });
        
        await user.save();
        
        // Return payment link to frontend
        return res.status(200).json({
          success: true,
          message: 'Payment initialized',
          data: {
            paymentLink: response.data.data.authorization_url,
            reference: reference
          }
        });
      } else {
        return res.status(400).json({
          success: false,
          message: 'Failed to initialize payment',
          error: response.data
        });
      }
    } catch (error) {
      console.error('Payment initialization error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Payment service error',
        error: error.message
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Verify wallet funding (webhook handler)
exports.verifyFunding = async (req, res) => {
  const signature = req.headers['x-paymentpoint-signature'];
  
  // Verify webhook signature
  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha512', PAYMENT_POINT_SECRET_KEY)
    .update(payload)
    .digest('hex');
  
  if (signature !== expectedSignature) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  
  try {
    const { reference, status, amount, metadata } = req.body;
    
    if (!metadata || !metadata.userId) {
      return res.status(400).json({ error: 'Invalid metadata' });
    }
    
    const user = await UserModel.findById(metadata.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Find the transaction in user's wallet
    const transactionIndex = user.wallet?.transactions.findIndex(
      t => t.reference === reference
    );
    
    if (transactionIndex === -1) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    if (status === 'success') {
      // Update transaction status
      user.wallet.transactions[transactionIndex].status = 'completed';
      user.wallet.transactions[transactionIndex].transactionId = req.body.id;
      
      // Update wallet balance
      const amountInNaira = amount / 100; // Convert kobo to naira
      user.wallet.balance = (user.wallet.balance || 0) + amountInNaira;
      user.wallet.lastFunded = new Date();
      
      await user.save();
      
      return res.status(200).json({ message: 'Payment verified and wallet updated' });
    } else {
      // Update transaction as failed
      user.wallet.transactions[transactionIndex].status = 'failed';
      await user.save();
      
      return res.status(200).json({ message: 'Payment failed' });
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Handle direct verification of funding (for frontend callback)
exports.checkFundingStatus = async (req, res) => {
  try {
    const { reference } = req.params;
    const { id: userId } = req.user;
    
    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if transaction exists and has been updated
    const transaction = user.wallet?.transactions.find(t => t.reference === reference);
    
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    // If transaction is still pending, verify with PaymentPoint
    if (transaction.status === 'pending') {
      try {
        const response = await axios.get(
          `${PAYMENT_POINT_API_URL}/transaction/verify/${reference}`,
          {
            headers: {
              'Authorization': `Bearer ${PAYMENT_POINT_SECRET_KEY}`
            }
          }
        );
        
        if (response.data && response.data.status === 'success' && 
            response.data.data.status === 'success') {
          
          // Update transaction and wallet
          const transactionIndex = user.wallet.transactions.findIndex(
            t => t.reference === reference
          );
          
          user.wallet.transactions[transactionIndex].status = 'completed';
          user.wallet.transactions[transactionIndex].transactionId = response.data.data.id;
          
          // Update wallet balance
          const amountInNaira = response.data.data.amount / 100;
          user.wallet.balance = (user.wallet.balance || 0) + amountInNaira;
          user.wallet.lastFunded = new Date();
          
          await user.save();
          
          return res.status(200).json({
            success: true,
            message: 'Payment confirmed',
            data: {
              transaction: user.wallet.transactions[transactionIndex],
              newBalance: user.wallet.balance
            }
          });
        } else {
          // If payment failed according to PaymentPoint
          const transactionIndex = user.wallet.transactions.findIndex(
            t => t.reference === reference
          );
          
          if (transactionIndex !== -1) {
            user.wallet.transactions[transactionIndex].status = 'failed';
            await user.save();
          }
          
          return res.status(200).json({
            success: false,
            message: 'Payment verification failed',
            data: { status: 'failed' }
          });
        }
      } catch (error) {
        console.error('Payment verification error:', error);
        return res.status(500).json({
          success: false,
          message: 'Error verifying payment',
          error: error.message
        });
      }
    }
    
    // Return existing transaction status
    return res.status(200).json({
      success: transaction.status === 'completed',
      message: transaction.status === 'completed' 
        ? 'Payment confirmed' 
        : 'Payment failed',
      data: {
        transaction,
        newBalance: user.wallet.balance
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Use wallet balance for transaction payment
exports.useWalletForPayment = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { amount, transactionId, description } = req.body;
    
    if (!amount || amount <= 0 || !transactionId) {
      return res.status(400).json({ error: "Valid amount and transaction ID are required" });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Check if user has sufficient balance
    const walletBalance = user.wallet?.balance || 0;
    if (walletBalance < amount) {
      return res.status(400).json({ 
        error: "Insufficient wallet balance",
        walletBalance,
        required: amount
      });
    }
    
    // Generate a reference for this payment
    const paymentReference = `WP-${userId.slice(-6)}-${Date.now()}`;
    
    // Deduct from wallet
    user.wallet.balance -= amount;
    
    // Add transaction record
    user.wallet.transactions.unshift({
      type: 'debit',
      amount: amount,
      description: description || `Payment for transaction #${transactionId}`,
      reference: paymentReference,
      status: 'completed',
      timestamp: new Date(),
      transactionId: transactionId
    });
    
    await user.save();
    
    // Return success with new balance
    return res.status(200).json({
      success: true,
      message: 'Payment successful',
      data: {
        paymentReference,
        newBalance: user.wallet.balance,
        transactionId
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};