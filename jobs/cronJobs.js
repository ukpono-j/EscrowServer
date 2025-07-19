const cron = require('node-cron');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const { syncAllWalletBalances, transferToPaystackTransferBalance } = require('../controllers/walletController');

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

  // Transfer pending deposits to Paystack Transfer balance every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    console.log('Running deposit transfer job at', new Date().toISOString());
    try {
      const wallets = await Wallet.find({
        'transactions.status': 'completed',
        'transactions.type': 'deposit',
        'transactions.metadata.transferredToBalance': { $ne: true },
      });

      for (const wallet of wallets) {
        const session = await Wallet.startSession();
        await session.withTransaction(async () => {
          const deposits = wallet.transactions
            .filter((t) => t.type === 'deposit' && t.status === 'completed' && !t.metadata.transferredToBalance)
            .reduce((sum, t) => sum + t.amount, 0);

          if (deposits > 0) {
            try {
              await transferToPaystackTransferBalance(deposits, `Batch transfer for user ${wallet.userId}`, session);
              wallet.transactions.forEach((t) => {
                if (t.type === 'deposit' && t.status === 'completed' && !t.metadata.transferredToBalance) {
                  t.metadata.transferredToBalance = true;
                }
              });
              wallet.markModified('transactions');
              await wallet.save({ session });
              console.log(`Transferred ₦${deposits.toFixed(2)} for user ${wallet.userId}`);
            } catch (error) {
              console.error(`Transfer failed for user ${wallet.userId}:`, error.message);
              await Notification.create(
                {
                  userId: 'admin',
                  title: 'Balance Transfer Failure',
                  message: `Failed to transfer ₦${deposits.toFixed(2)} for user ${wallet.userId}: ${error.message}`,
                  type: 'admin_alert',
                  status: 'error',
                },
                { session }
              );
            }
          }
        });
        session.endSession();
      }
      console.log('Deposit transfer job completed');
    } catch (error) {
      console.error('Deposit transfer job error:', error.message);
    }
  });
};