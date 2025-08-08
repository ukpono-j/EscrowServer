const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  title: {
    type: String,
    default: "Notification",
  },
  message: {
    type: String,
    default: "No message provided",
  },
  type: {
    type: String,
    enum: ["transaction", "waybill", "funding", "confirmation", "payment", "registration", "withdrawal", "kyc", "system"],
    default: "transaction",
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["pending", "accepted", "declined", "completed", "canceled", "failed", "error", "warning", "funded"],
    default: "pending",
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: ["buyer", "seller"],
      required: true,
    },
  }],
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    required: false, // Already set to false, kept for compatibility
  },
  reference: { // New field for string-based references
    type: String,
    required: false,
  },
});

const Notification = mongoose.model("Notification", notificationSchema);
module.exports = Notification;