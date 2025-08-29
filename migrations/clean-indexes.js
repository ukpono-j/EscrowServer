require('dotenv').config(); // Load environment variables

const mongoose = require('mongoose');
const connectDB = require('../config/db');

async function cleanDuplicateIndexes() {
  try {
    await connectDB();
    const db = mongoose.connection.db;

    // List indexes for the 'wallets' collection
    const indexes = await db.collection('wallets').listIndexes().toArray();
    console.log('Current indexes:', JSON.stringify(indexes, null, 2));

    const indexesToDrop = [
      'userId_1', // Non-unique index, if exists
      'transactions.reference_1', // Non-unique index, if exists
      'transactions.paystackReference_1', // Non-unique index, if exists
      'withdrawalRequests.reference_1', // Non-unique index, if exists
    ];

    for (const indexName of indexesToDrop) {
      try {
        await db.collection('wallets').dropIndex(indexName);
        console.log(`Dropped index: ${indexName}`);
      } catch (error) {
        console.warn(`Could not drop index ${indexName}: ${error.message}`);
      }
    }

    console.log('Index cleanup completed');
    process.exit(0);
  } catch (error) {
    console.error('Error cleaning indexes:', error);
    process.exit(1);
  }
}

cleanDuplicateIndexes();