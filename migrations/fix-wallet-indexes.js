require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');

async function fixWalletIndexes() {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    const collection = db.collection('wallets');

    // List current indexes
    const indexes = await collection.listIndexes().toArray();
    console.log('Current indexes:', JSON.stringify(indexes, null, 2));

    // Drop unexpected indexes (if not needed)
    const indexesToDrop = [
      'lastPaystackSync_1', // Not in current schema
      'userId_1_withdrawalRequests.status_1', // Not in current schema
    ];

    for (const indexName of indexesToDrop) {
      try {
        await collection.dropIndex(indexName);
        console.log(`Dropped index: ${indexName}`);
      } catch (error) {
        console.warn(`Could not drop index ${indexName}: ${error.message}`);
      }
    }

    // Recreate required indexes from walletSchema
    const requiredIndexes = [
      { key: { userId: 1 }, name: 'userId_1', unique: true },
      { key: { 'transactions.reference': 1 }, name: 'transactions.reference_1', unique: true },
      { key: { 'transactions.paystackReference': 1 }, name: 'transactions.paystackReference_1', sparse: true, unique: true },
      { key: { 'transactions.metadata.virtualAccountId': 1 }, name: 'transactions.metadata.virtualAccountId_1', sparse: true },
      { key: { 'withdrawalRequests.reference': 1 }, name: 'withdrawalRequests.reference_1', unique: true },
    ];

    for (const index of requiredIndexes) {
      try {
        await collection.createIndex(index.key, {
          name: index.name,
          unique: index.unique || false,
          sparse: index.sparse || false,
          background: true,
        });
        console.log(`Created index: ${index.name}`);
      } catch (error) {
        console.warn(`Could not create index ${index.name}: ${error.message}`);
      }
    }

    // List indexes again to confirm
    const updatedIndexes = await collection.listIndexes().toArray();
    console.log('Updated indexes:', JSON.stringify(updatedIndexes, null, 2));

    console.log('Index fix completed');
    process.exit(0);
  } catch (error) {
    console.error('Error fixing indexes:', error);
    process.exit(1);
  }
}

fixWalletIndexes();