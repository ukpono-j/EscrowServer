const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    // required: true, // Keep userId required
    index: true
  },
  title: {
    type: String,
    default: "Notification", // Provide a default value
  },
  message: {
    type: String,
    default: "No message provided", // Provide a default value
  },
  type: {
    type: String,
    enum: ["transaction", "waybill", "funding", "confirmation", "payment", "registration"],
    default: "transaction",
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["pending", "accepted", "declined", "completed", "cancelled", "failed"],
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