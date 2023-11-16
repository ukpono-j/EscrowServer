const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    message: {
      text: {
        type: String,
        required: true,
      },
      media: {
        type: String,
      },
      users: Array,
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    },
  },
  { timestamps: true } // Move timestamps option here
);

const MessageModel = mongoose.model("Messages", MessageSchema);
module.exports = MessageModel;
