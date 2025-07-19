const cron = require('node-cron');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const { syncAllWalletBalances } = require('../controllers/walletController');

module.exports = () => {
  // Sync wallet balances every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('Running wallet balance sync job at', new Date().toISOString());
    try {
      await syncAllWalletBalances();
      console.log('Wallet balance sync completed');
    } catch (error) {
      console.error('Wallet balance sync error:', error.message);
    }
  });

  // Clean up old pending transactions daily at midnight
  cron.schedule('0 0 * * *', async () => {
    console.log('Running transaction cleanup job at', new Date().toISOString());
    try {
      const timeoutThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
      const wallets = await Wallet.find({
        'transactions.status': 'pending',
        'transactions.createdAt': { $lt: new Date(Date.now() - timeoutThreshold) },
      });

      for (const wallet of wallets) {
        const session = await Wallet.startSession();
        await session.withTransaction(async () => {
          for (const transaction of wallet.transactions.filter(
            (t) => t.status === 'pending' && new Date(t.createdAt) < new Date(Date.now() - timeoutThreshold)
          )) {
            transaction.status = 'cancelled';
            transaction.metadata.error = 'Transaction timed out after 7 days';
            wallet.markModified('transactions');
            await wallet.save({ session });

            await Notification.create(
              {
                userId: wallet.userId,
                title: 'Transaction Cancelled',
                message: `Transaction ${transaction.reference} was cancelled due to inactivity.`,
                transactionId: transaction.reference,
                type: 'funding',
                status: 'cancelled',
              },
              { session }
            );
          }
        });
        session.endSession();
      }
      console.log('Transaction cleanup completed');
    } catch (error) {
      console.error('Transaction cleanup error:', error.message);
    }
  });

  // Retry pending transactions every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    console.log('Running pending transaction retry job at', new Date().toISOString());
    try {
      const { retryPendingTransactions } = require('../controllers/walletController');
      await retryPendingTransactions();
      console.log('Pending transaction retry job completed');
    } catch (error) {
      console.error('Pending transaction retry job error:', error.message);
    }
  });
};