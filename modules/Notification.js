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
    enum: ["pending", "accepted", "declined", "completed", "cancelled", "failed", "error", "warning"],
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
    },
  }],
});

const Notification = mongoose.model("Notification", notificationSchema);
module.exports = Notification;