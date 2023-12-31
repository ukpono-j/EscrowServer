const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId, // Assuming you're using MongoDB ObjectId for user IDs
    required: true,
  },
  
  transactionId: {
    type: String,
    required: true,
  },
  paymentName: {
    type: String,
    required: true,
  },
  paymentBank: {
    type: String,
    required: true,
  },
  paymentAccountNumber: {
    type: Number,
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
  proofOfWaybill: {
    type: String,
    enum: ["pending", "confirmed", ],
    default: "pending",
  },
  // participants: [{ type: String }], // Array to store participants' emails
  participants: [],
  createdAt: {
    type: Date, // Store the creation timestamp as a Date object
    default: Date.now, // Set the default value to the current date and time
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "completed", ],
    default: "active",
  },
  paymentStatus: {
    type: String,
    enum: ["active", "paid", ],
    default: "active",
  },
  buyerConfirmedReceipt: {
    type: Boolean,
    default: false,
  },
  // Additional fields for your transaction model can be added here
  // ...
});

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
