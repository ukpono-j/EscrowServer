const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MongoDB URI is not defined in environment variables');
    }

    console.log('Attempting to connect to MongoDB with URI:', uri.replace(/\/\/(.+?)@/, '//[REDACTED]@')); // Log URI for debugging (hide credentials)

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 30000, // 30 seconds to select server
      socketTimeoutMS: 45000, // 45 seconds for socket operations
      connectTimeoutMS: 30000, // 30 seconds for initial connection
    });

    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1); // Exit process on failure
  }
};

module.exports = connectDB;