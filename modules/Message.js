const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatroomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chatroom',
    required: true,
  },
  userId: {
    type: String,
    required: true,
  },
  userFirstName: {
    type: String,
    required: true,
  },
  userLastName: {
    type: String,
    default: '',
  },
  message: {
    type: String,
    required: true,
  },
  avatarSeed: {
    type: String,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// Added index for efficient querying
messageSchema.index({ chatroomId: 1, timestamp: 1 });

module.exports = mongoose.model('Message', messageSchema);