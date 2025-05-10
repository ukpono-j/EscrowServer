const mongoose = require('mongoose');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');

async function reconcileWallets() {
  try {
    // Connect to the MongoDB database
    await mongoose.connect('mongodb://localhost:27017/test', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Fetch all users
    const users = await User.find({});
    console.log(`Found ${users.length} users`);

    // Iterate through each user
    for (const user of users) {
      const wallet = await Wallet.findOne({ userId: user._id });
      if (!wallet) {
        console.log(`Creating wallet for user: ${user._id} (${user.email})`);
        const newWallet = new Wallet({
          userId: user._id,
          balance: 0,
          totalDeposits: 0,
          currency: 'NGN',
          transactions: [],
        });
        await newWallet.save();
        console.log(`Wallet created for user: ${user._id}`);
      } else {
        console.log(`Wallet already exists for user: ${user._id} (${user.email})`);
      }
    }

    console.log('Wallet reconciliation complete');
  } catch (error) {
    console.error('Error during wallet reconciliation:', error);
  } finally {
    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the script
reconcileWallets();