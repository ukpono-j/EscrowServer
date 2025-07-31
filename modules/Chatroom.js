// modules/Chatroom.js
const mongoose = require("mongoose");

const chatroomSchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    required: true,
    unique: true, // Ensure one chatroom per transaction
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  }],
});

// Add index for efficient querying
chatroomSchema.index({ transactionId: 1 });

const Chatroom = mongoose.model("Chatroom", chatroomSchema);

module.exports = Chatroom;