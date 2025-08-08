const mongoose = require('mongoose');
const Transaction = require('./modules/Transactions'); // Adjust path

async function migrateTransactions() {
  try {
   await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://zeek:Outside2021@escrow0.4bjhmuq.mongodb.net/escrow0?retryWrites=true&w=majority', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    const transactions = await Transaction.find({}).lean();
    for (const transaction of transactions) {
      const updatedParticipants = transaction.participants.map(participant => ({
        ...participant,
        role: transaction.selectedUserType === 'buyer' ? 'seller' : 'buyer',
      }));
      await Transaction.updateOne(
        { _id: transaction._id },
        { $set: { participants: updatedParticipants } }
      );
      console.log(`Updated transaction ${transaction._id}`);
    }
    console.log('Migration completed');
    mongoose.disconnect();
  } catch (error) {
    console.error('Migration failed:', error);
  }
}

migrateTransactions();