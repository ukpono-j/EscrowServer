const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },

  bank: {
    type: String,
  },
  accountNumber: {
    type: String,
  },
  dateOfBirth: {
    type: String,
  },
  isAvatarImageSet: {
    type: Boolean,
    default: false, // Default value is set to false
  },
  avatarImage: {
    type: String,
  },
  // Wallet functionality
  wallet: {
    balance: {
      type: Number,
      default: 0
    },
    lastFunded: {
      type: Date
    },
    transactions: [
      {
        type: {
          type: String,
          enum: ['credit', 'debit'],
          required: true
        },
        amount: {
          type: Number,
          required: true
        },
        description: {
          type: String,
          required: true
        },
        reference: {
          type: String
        },
        transactionId: {
          type: String
        },
        timestamp: {
          type: Date,
          default: Date.now
        },
        status: {
          type: String,
          enum: ['pending', 'completed', 'failed'],
          default: 'pending'
        }
      }
    ]
  }
});

const UserModel = mongoose.model("User", UserSchema);
module.exports = UserModel;
