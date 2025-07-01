const mongoose = require('mongoose');
  const Wallet = require('./modules/wallet');
  const Notification = require('./modules/Notification');

  exports.reconcileStuckTransactions = async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const wallets = await Wallet.find({
        'transactions.status': 'pending',
        'transactions.metadata.transferredToBalance': true, // Only reconcile funded transactions
        'transactions.createdAt': { $lt: threshold },
      }).session(session);

      console.log(`Starting reconciliation: Found ${wallets.length} wallets with stuck transactions`);

      for (const wallet of wallets) {
        const stuckTransactions = wallet.transactions.filter(
          t => t.status === 'pending' && t.metadata.transferredToBalance && new Date(t.createdAt) < threshold
        );

        for (const transaction of stuckTransactions) {
          console.log(`Reconciling stuck transaction: ${transaction.reference}`, {
            userId: wallet.userId,
            amount: transaction.amount,
            createdAt: transaction.createdAt,
          });

          transaction.status = 'cancelled';
          transaction.metadata.error = 'Transaction timed out';
          wallet.balance += transaction.amount; // Refund to wallet
          wallet.markModified('transactions');

          await Notification.create([{
            userId: wallet.userId,
            title: 'Transaction Cancelled',
            message: `Transaction ${transaction.reference} was cancelled due to inactivity. ₦${transaction.amount.toFixed(2)} refunded.`,
            transactionId: transaction.reference,
            type: 'funding',
            status: 'cancelled',
          }], { session });

          console.log(`Transaction cancelled and refunded: ${transaction.reference}`, {
            userId: wallet.userId,
            status: transaction.status,
            refundedAmount: transaction.amount,
          });
        }

        await wallet.save({ session });
        console.log(`Wallet updated: ${wallet._id}`, { newBalance: wallet.balance });
      }

      await session.commitTransaction();
      console.log(`Reconciliation completed: ${wallets.length} wallets processed`);
    } catch (error) {
      console.error('Error in reconciliation:', {
        message: error.message,
        stack: error.stack,
      });
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  };