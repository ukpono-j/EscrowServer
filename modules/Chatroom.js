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
  });
  
  const Chatroom = mongoose.model("Chatroom", chatroomSchema);
  
  module.exports = Chatroom;
  