const cron = require('node-cron');
const Transaction = require('./modules/Transactions');
const { refundBuyer } = require('./controllers/transactionController');

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