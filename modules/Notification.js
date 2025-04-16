const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  transactionId: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ["transaction", "waybill", "funding", "confirmation", "payment"],
    default: "transaction",
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String, // "pending", "accepted", "declined"
    enum: ["pending", "accepted", "declined", "completed", "cancelled"],
    default: "pending",
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  }]
});

const Notification = mongoose.model("Notification", notificationSchema);

module.exports = Notification;
