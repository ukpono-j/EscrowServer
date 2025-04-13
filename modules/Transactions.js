const mongoose = require("mongoose");


const waybillSchema = new mongoose.Schema({
  item: { type: String, required: true },
  image: { type: String }, // Store image path or binary data
  price: { type: Number, required: true },
  shippingAddress: { type: String, required: true },
  trackingNumber: { type: String, required: true },
  deliveryDate: { type: Date, required: true },
});



const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId, // Assuming you're using MongoDB ObjectId for user IDs
    ref: "User",
    required: true,
  },

  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    default: mongoose.Types.ObjectId, // Default to a new ObjectId
  },
  paymentName: {
    type: String,
    required: true,
  },
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
  paymentDescription: {
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
    enum: ["pending", "confirmed",],
    default: "pending",
  },
  // participants: [{ type: String }], // Array to store participants' emails
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  chatroomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chatroom",
  },
  createdAt: {
    type: Date, // Store the creation timestamp as a Date object
    default: Date.now, // Set the default value to the current date and time
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "completed", "pending"],
    default: "active",
  },
  paymentStatus: {
    type: String,
    enum: ["active", "paid",],
    default: "active",
  },

  buyerConfirmedReceipt: {
    type: Boolean,
    default: false,
  },
    // Nested waybill details schema
    waybillDetails: { type: waybillSchema },
    buyerConfirmed: {
      type: Boolean,
      default: false,
    },
    sellerConfirmed: {
      type: Boolean,
      default: false,
    },
    payoutReleased: {
      type: Boolean,
      default: false
    },
    funded: {
      type: Boolean,
      default: false,
    },
    paymentReference: {
      type: String,
      unique: true,
      sparse: true  // This allows multiple null values
    },
    payoutReference: {
      type: String,
      unique: true,
      sparse: true
    },
    paymentBankCode: {
      type: String,
      required: true,
    },
    payoutError: {
      type: String,
      default: null
    },
    
  // Add waybill details
  // waybillDetails: {
  //   item: String,
  //   image: String,
  //   price: Number,
  //   shippingAddress: String,
  //   trackingNumber: String,
  //   deliveryDate: Date,
  // }
  // Additional fields for your transaction model can be added here
  // ...
});

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
