const mongoose = require("mongoose");

const chatroomSchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    required: true,
    unique: true,
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
});

// Add index for efficient querying
chatroomSchema.index({ transactionId: 1 });

const Chatroom = mongoose.model("Chatroom", chatroomSchema);

module.exports = Chatroom;