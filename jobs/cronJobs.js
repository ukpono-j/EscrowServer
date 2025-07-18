const cron = require('node-cron');
const axios = require('axios');
const { syncAllWalletBalances, transferToPaystackTransferBalance } = require('../controllers/walletController');
const { reconcileStuckTransactions } = require('../reconciliation');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');

module.exports = () => {
  // Wallet balance sync (every 30 minutes)
  cron.schedule('*/30 * * * *', async () => {
    console.log('Running wallet balance sync job at', new Date().toISOString());
    try {
      await syncAllWalletBalances();
      console.log('Wallet balance sync completed');
    } catch (error) {
      console.error('Wallet balance sync error:', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  // Reconcile stuck transactions (every 6 hours)
  cron.schedule('0 */6 * * *', async () => {
    console.log('Running transaction reconciliation job at', new Date().toISOString());
    try {
      await reconcileStuckTransactions();
      console.log('Transaction reconciliation completed');
    } catch (error) {
      console.error('Transaction reconciliation error:', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  // Clean up old pending transactions (daily at midnight)
  cron.schedule('0 0 * * *', async () => {
    console.log('Running transaction cleanup job at', new Date().toISOString());
    try {
      const timeoutThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
      const wallets = await Wallet.find({
        'transactions.status': 'pending',
        'transactions.createdAt': { $lt: new Date(Date.now() - timeoutThreshold) },
      });

      for (const wallet of wallets) {
        for (const transaction of wallet.transactions.filter(t => t.status === 'pending' && new Date(t.createdAt) < new Date(Date.now() - timeoutThreshold))) {
          transaction.status = 'cancelled';
          transaction.metadata.error = 'Transaction timed out after 7 days';
          wallet.markModified('transactions');
          await wallet.save();
          console.log('Cancelled transaction:', transaction.reference);

          await Notification.create({
            userId: wallet.userId,
            title: 'Transaction Cancelled',
            message: `Transaction ${transaction.reference} was cancelled due to inactivity.`,
            transactionId: transaction.reference,
            type: 'funding',
            status: 'cancelled',
          });
        }
      }
      console.log('Transaction cleanup completed');
    } catch (error) {
      console.error('Transaction cleanup error:', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  // Check Paystack balance (daily at midnight)
  cron.schedule('0 0 * * *', async () => {
    console.log('Running Paystack balance check job at', new Date().toISOString());
    try {
      const secretKey = process.env.NODE_ENV === 'production' ? process.env.PAYSTACK_LIVE_SECRET_KEY : process.env.PAYSTACK_SECRET_KEY;
      const response = await axios.get('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      if (!response.data?.status) {
        throw new Error('Failed to check Paystack balance');
      }

      const transferBalance = response.data.data.find(b => b.balance_type === 'transfers')?.balance / 100 || 0;
      const revenueBalance = response.data.data.find(b => b.balance_type === 'revenue')?.balance / 100 || 0;
      if (transferBalance < 1000) {
        await Notification.create({
          userId: 'admin', // Replace with actual admin ID
          title: 'Low Paystack Transfer Balance Alert',
          message: `Paystack Transfer balance is ₦${transferBalance.toFixed(2)}, below threshold of ₦1000. Revenue balance: ₦${revenueBalance.toFixed(2)}.`,
          type: 'admin_alert',
          status: 'pending',
        });
        console.log('Admin notified of low Paystack Transfer balance:', transferBalance);
      }
      console.log('Paystack balance check completed:', { transferBalance, revenueBalance });
    } catch (error) {
      console.error('Paystack balance check error:', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  // Transfer pending deposits to Transfer balance (every 2 hours)
  cron.schedule('0 */2 * * *', async () => {
    console.log('Running Revenue to Transfer balance job at', new Date().toISOString());
    try {
      const wallets = await Wallet.find({
        'transactions.status': 'completed',
        'transactions.type': 'deposit',
        'transactions.metadata.transferredToBalance': { $ne: true },
      });
      for (const wallet of wallets) {
        const deposits = wallet.transactions
          .filter(t => t.type === 'deposit' && t.status === 'completed' && !t.metadata.transferredToBalance)
          .reduce((sum, t) => sum + t.amount, 0);
        if (deposits > 0) {
          try {
            await transferToPaystackTransferBalance(deposits, `Batch transfer for user ${wallet.userId}`);
            wallet.transactions.forEach(t => {
              if (t.type === 'deposit' && t.status === 'completed' && !t.metadata.transferredToBalance) {
                t.metadata.transferredToBalance = true;
              }
            });
            wallet.markModified('transactions');
            await wallet.save();
            console.log(`Transferred ₦${deposits.toFixed(2)} to Transfer balance for user ${wallet.userId}`);
          } catch (error) {
            console.error(`Failed to transfer balance for wallet ${wallet._id}:`, error.message);
            await Notification.create({
              userId: 'admin',
              title: 'Balance Transfer Failure',
              message: `Failed to transfer ₦${deposits.toFixed(2)} to Transfer balance for user ${wallet.userId}: ${error.message}`,
              type: 'admin_alert',
              status: 'error',
            });
          }
        }
      }
      console.log('Revenue to Transfer balance job completed');
    } catch (error) {
      console.error('Revenue to Transfer balance job error:', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  // Running retryPendingTransactions job
  cron.schedule('0 */5 * * *', async () => {
    console.log('Running retryPendingTransactions job');
    await retryPendingTransactions();
  });
};