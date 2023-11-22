const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    message: {
      text: {
        type: String,
        // required: true,
      },
      users: Array,
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
      // media: {
      //   data: Buffer,
      //   contentType: String,
      // }
      media: String,
      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
  },
  // { timestamps: true } // Move timestamps option here
);

const MessageModel = mongoose.model("Messages", MessageSchema);
module.exports = MessageModel;

