const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true,
  },
  paymentName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  paymentAmount: {
    type: Number,
    required: true,
  },
  paymentDscription: {
    type: String,
    required: true,
  },
  selectedUserType: {
    type: String,
    required: true,
  },
  willUseCourier: {
    type: Boolean,
    required: true,
  },
  // Additional fields for your transaction model can be added here
  // ...
});

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
