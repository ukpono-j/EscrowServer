const mongoose = require('mongoose');
const Transaction = require('./modules/Transactions');
const Wallet = require('./modules/wallet');
const Notification = require('./modules/Notification');

exports.reconcileStuckTransactions = async () => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
    const stuckTransactions = await Transaction.find({
      status: 'pending',
      locked: true,
      funded: true,
      createdAt: { $lt: threshold },
    }).session(session);

    console.log(`Starting reconciliation: Found ${stuckTransactions.length} stuck transactions`);

    for (const transaction of stuckTransactions) {
      console.log(`Reconciling stuck transaction: ${transaction._id}`, {
        buyerWalletId: transaction.buyerWalletId,
        lockedAmount: transaction.lockedAmount,
        createdAt: transaction.createdAt,
      });

      if (transaction.buyerWalletId) {
        const buyerWallet = await Wallet.findById(transaction.buyerWalletId).session(session);
        if (buyerWallet) {
          const refundAmount = transaction.lockedAmount;
          buyerWallet.balance += refundAmount;
          buyerWallet.transactions.push({
            type: 'deposit',
            amount: refundAmount,
            reference: `REFUND-STUCK-${transaction._id}`,
            status: 'completed',
            metadata: {
              purpose: 'Refund for stuck transaction',
              transactionId: transaction._id,
            },
            createdAt: new Date(),
          });
          await buyerWallet.save({ session });

          console.log(`Refunded ${refundAmount} to buyer wallet: ${buyerWallet._id}`, {
            newBalance: buyerWallet.balance,
            userId: buyerWallet.userId,
          });

          const notification = new Notification({
            userId: buyerWallet.userId,
            title: 'Transaction Refund',
            message: `Transaction ${transaction._id} was refunded due to inactivity.`,
            transactionId: transaction._id.toString(),
            type: 'refund',
            status: 'completed',
          });
          await notification.save({ session });

          console.log(`Notification sent for refund: ${transaction._id}`, {
            userId: buyerWallet.userId,
            notificationId: notification._id,
          });
        } else {
          console.warn(`Buyer wallet not found for transaction: ${transaction._id}`, {
            buyerWalletId: transaction.buyerWalletId,
          });
        }
      } else {
        console.warn(`No buyer wallet ID for transaction: ${transaction._id}`);
      }

      transaction.status = 'cancelled';
      transaction.locked = false;
      transaction.lockedAmount = 0;
      await transaction.save({ session });

      console.log(`Transaction cancelled: ${transaction._id}`, {
        status: transaction.status,
        locked: transaction.locked,
        lockedAmount: transaction.lockedAmount,
      });
    }

    await session.commitTransaction();
    session.endSession();
    console.log(`Reconciliation completed: ${stuckTransactions.length} transactions processed`);
  } catch (error) {
    console.error('Error in reconciliation:', {
      message: error.message,
      stack: error.stack,
    });
    await session.abortTransaction();
    session.endSession();
    throw error; // Let cron job handle the error
  }
};