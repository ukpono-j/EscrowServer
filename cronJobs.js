const cron = require('node-cron');
const { reconcileStuckTransactions } = require('./reconciliation');
const Transaction = require('./modules/Transactions');
const { refundBuyer } = require('./controllers/transactionController');

module.exports = () => {
  // Cron job for reconciling stuck transactions (every 6 hours)
  cron.schedule('0 */6 * * *', async () => {
    console.log('Running transaction reconciliation job');
    await reconcileStuckTransactions();
  });

  // Cron job for cleaning up old pending transactions (daily at midnight)
  cron.schedule('0 0 * * *', async () => {
    console.log('Running transaction cleanup cron job');
    try {
      const timeoutThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
      const transactions = await Transaction.find({
        status: 'pending',
        createdAt: { $lt: new Date(Date.now() - timeoutThreshold) },
      });

      for (const transaction of transactions) {
        await refundBuyer(transaction._id);
        transaction.status = 'cancelled';
        await transaction.save();
        console.log('Cancelled transaction:', transaction._id);
      }
    } catch (error) {
      console.error('Transaction cleanup error:', error);
    }
  });
};