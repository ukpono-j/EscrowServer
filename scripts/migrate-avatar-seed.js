const mongoose = require('mongoose');
const User = require('./modules/Users'); // Adjust the path to your User model
require('dotenv').config();

async function migrateAvatarSeed() {
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Step 1: Drop the avatarSeed_1 index
    console.log('Checking for avatarSeed_1 index...');
    try {
      await mongoose.connection.db.collection('users').dropIndex('avatarSeed_1');
      console.log('Dropped avatarSeed_1 index successfully');
    } catch (error) {
      if (error.codeName === 'IndexNotFound') {
        console.log('avatarSeed_1 index not found, no need to drop');
      } else {
        console.error('Error dropping avatarSeed_1 index:', error.message);
        throw error;
      }
    }

    // Step 2: Remove avatarSeed field from all user documents
    console.log('Removing avatarSeed field from user documents...');
    const result = await User.updateMany(
      { avatarSeed: { $exists: true } },
      { $unset: { avatarSeed: '' } }
    );
    console.log(`Removed avatarSeed field from ${result.modifiedCount} user documents`);

    // Step 3: Verify current indexes
    const indexes = await mongoose.connection.db.collection('users').indexes();
    console.log('Current indexes on users collection:', JSON.stringify(indexes, null, 2));

    // Step 4: Verify schema alignment
    const sampleUser = await User.findOne();
    if (sampleUser) {
      console.log('Sample user document:', JSON.stringify(sampleUser, null, 2));
    } else {
      console.log('No users found in the collection');
    }

    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration error:', error.message, error.stack);
  } finally {
    // Close the MongoDB connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

migrateAvatarSeed().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});