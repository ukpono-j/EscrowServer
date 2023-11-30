const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },

  bank: {
    type: String,
  },
  accountNumber: {
    type: String,
  },
  dateOfBirth: {
    type: String,
  },
  isAvatarImageSet: {
    type: Boolean,
    default: false, // Default value is set to false
  },
  avatarImage: {
    type: String,
  },
  // isSuperAdmin: {
  //   type: Boolean,
  //   default: false,
  // },
});

const UserModel = mongoose.model("User", UserSchema);
module.exports = UserModel;
