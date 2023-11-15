const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  message: {
    text: {
      type: String, // Fix: Added type for String
      required: true,
    },
    media: {
        type: String, // Assuming you store the media URL or path as a string
      },
    users: Array,
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
}, {
  timestamps: true, // Moved timestamps option outside of the message object
});

const MessageModel = mongoose.model("Messages", MessageSchema);
module.exports = MessageModel;
