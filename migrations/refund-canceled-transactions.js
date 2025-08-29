require('dotenv').config(); // Add this at the top

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Transaction = require('../modules/Transactions');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');

async function refundCanceledTransactions() {
  try {
    await connectDB(); // Connect to DB

    const canceledTransactions = await Transaction.find({
      status: 'canceled',
      locked: true,
      lockedAmount: { $gt: 0 },
      participants: { $size: 0 },
    });

    console.log(`Found ${canceledTransactions.length} transactions to refund`);

    for (const transaction of canceledTransactions) {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const buyerWallet = await Wallet.findById(transaction.buyerWalletId).session(session);
        if (buyerWallet) {
          const refundedAmount = transaction.lockedAmount;
          buyerWallet.balance += refundedAmount;
          buyerWallet.transactions.push({
            type: "deposit",
            amount: refundedAmount,
            reference: `REFUND-${transaction._id}`,
            status: "completed",
            metadata: {
              purpose: "Transaction cancellation refund (migration)",
              transactionId: transaction._id,
            },
            createdAt: new Date(),
          });
          await buyerWallet.save({ session });

          const refundNotification = new Notification({
            userId: buyerWallet.userId.toString(),
            title: "Transaction Refund (Migration)",
            message: `Transaction ${transaction._id} was canceled, and ₦${refundedAmount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} has been refunded to your wallet (system update).`,
            transactionId: transaction._id.toString(),
            type: "transaction",
            status: "completed",
          });
          await refundNotification.save({ session });

          transaction.locked = false;
          transaction.lockedAmount = 0;
          await transaction.save({ session });

          console.log(`Refunded transaction ${transaction._id}: ₦${refundedAmount}`);
        } else {
          console.warn(`Buyer wallet not found for transaction ${transaction._id}`);
          await session.abortTransaction();
        }
        await session.commitTransaction();
      } catch (error) {
        console.error(`Error refunding transaction ${transaction._id}:`, error);
        await session.abortTransaction();
      } finally {
        session.endSession();
      }
    }

    console.log('Migration completed');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

refundCanceledTransactions();