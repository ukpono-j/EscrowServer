const mongoose = require('mongoose');
const Wallet = require('../modules/wallet');
const crypto = require('crypto');

// MongoDB connection configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://zeek:Outside2021@escrow0.4bjhmuq.mongodb.net/?retryWrites=true&w=majority'; // Adjust to your MongoDB URI

async function connectToMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

async function cleanUp() {
  try {
    const wallets = await Wallet.find({
      $or: [
        { 'transactions.reference': null },
        { 'transactions.reference': { $exists: false } },
      ],
    });
    console.log(`Found ${wallets.length} wallets with null or missing transaction references`);

    for (const wallet of wallets) {
      wallet.transactions = wallet.transactions.map((tx, index) => {
        if (!tx.reference) {
          tx.reference = `FIX-${crypto.randomBytes(4).toString('hex')}-${Date.now()}-${index}`;
          console.log(`Assigned new reference to transaction in wallet ${wallet._id}: ${tx.reference}`);
        }
        return tx;
      });
      await wallet.save();
      console.log(`Cleaned wallet ${wallet._id}`);
    }
    console.log('Wallet cleanup completed successfully');
  } catch (error) {
    console.error('Error cleaning wallets:', error.message);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Run the cleanup
(async () => {
  await connectToMongoDB();
  await cleanUp();
  process.exit(0);
})();