const mongoose = require("mongoose");

const waybillSchema = new mongoose.Schema({
  item: { type: String, required: true },
  image: { type: String },
  price: { type: Number }, // Made optional to align with frontend
  shippingAddress: { type: String, required: true },
  trackingNumber: { type: String, required: true },
  deliveryDate: { type: Date, required: true },
});

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  paymentName: {
    type: String,
    required: true,
  },
  paymentBank: {
    type: String,
    required: [function () { return this.selectedUserType === "seller"; }, "Payment bank is required for sellers"],
    default: "Pending",
  },
  paymentAccountNumber: {
    type: String,
    required: [function () { return this.selectedUserType === "seller"; }, "Payment account number is required for sellers"],
    default: "0",
  },
  email: {
    type: String,
    required: true,
  },
  paymentAmount: {
    type: Number,
    required: true,
  },
  productDetails: {
    description: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
  },
  selectedUserType: {
    type: String,
    required: true,
    enum: ["buyer", "seller"],
  },
  proofOfWaybill: {
    type: String,
    enum: ["pending", "confirmed"],
    default: "pending",
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true
  }],
  chatroomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chatroom",
    validate: {
      validator: async function (value) {
        if (!value) return true;
        const chatroom = await mongoose.model("Chatroom").findById(value);
        return !!chatroom;
      },
      message: "Invalid chatroom ID",
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["pending", "funded", "completed", "cancelled"], // Consolidated status
    default: "pending",
    index: true,
  },
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
    default: false,
  },
  funded: {
    type: Boolean,
    default: false,
  },
  paymentBankCode: {
    type: String,
    required: [function () { return this.selectedUserType === "seller"; }, "Payment bank code is required for sellers"],
    default: "000",
  },
  waybillDetails: { type: waybillSchema },
  buyerWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Wallet",
    validate: {
      validator: async function (value) {
        if (!value) return true;
        const wallet = await mongoose.model("Wallet").findById(value);
        return !!wallet;
      },
      message: "Invalid or missing buyer wallet",
    },
  },
  sellerWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Wallet",
    validate: {
      validator: async function (value) {
        if (!value) return true;
        const wallet = await mongoose.model("Wallet").findById(value);
        return !!wallet;
      },
      message: "Invalid or missing seller wallet",
    },
  },
  locked: {
    type: Boolean,
    default: false,
  },
  lockedAmount: {
    type: Number,
    default: 0,
  },
});

transactionSchema.pre('save', async function (next) {
  if (this.funded || this.status === 'completed') {
    if (!this.buyerWalletId && this.selectedUserType === "buyer") {
      return next(new Error('Buyer wallet is required for funded or completed transactions'));
    }
    if (!this.sellerWalletId && this.selectedUserType === "seller") {
      return next(new Error('Seller wallet is required for funded or completed transactions'));
    }
  }
  if (this.buyerConfirmed && this.sellerConfirmed && this.status !== 'completed') {
    this.status = 'completed';
    this.payoutReleased = true; // Ensure payout is marked as released
  }
  next();
});

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;