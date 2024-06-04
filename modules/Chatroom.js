const mongoose = require("mongoose");

const chatroomSchema = new mongoose.Schema({
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },
    participants: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }],
    messages: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        message: {
          type: String,
          required: true,
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Other chatroom fields...
  });
  
  const Chatroom = mongoose.model("Chatroom", chatroomSchema);
  
  module.exports = Chatroom;
  