const mongoose = require("mongoose");

const waybillSchema = new mongoose.Schema({
  item: { type: String, required: true },
  image: { type: String },
  price: { type: Number, required: true },
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
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    default: mongoose.Types.ObjectId,
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
    enum: ['buyer', 'seller'],
  },
  willUseCourier: {
    type: Boolean,
  },
  proofOfWaybill: {
    type: String,
    enum: ["pending", "confirmed"],
    default: "pending",
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  chatroomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chatroom",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "completed", "pending"],
    default: "active",
  },
  paymentStatus: {
    type: String,
    enum: ["active", "paid"],
    default: "active",
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
    required: true,
    default: "000",
  },
  waybillDetails: { type: waybillSchema },
  buyerWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
    required: [function () { return this.status === 'completed' || this.funded; }, 'Buyer wallet is required for funded or completed transactions'],
    validate: {
      validator: async function (value) {
        if (!value) return false;
        const wallet = await mongoose.model('Wallet').findById(value);
        return !!wallet;
      },
      message: 'Invalid or missing buyer wallet',
    },
  },
  sellerWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
    required: [function () { return this.status === 'completed' || this.funded; }, 'Seller wallet is required for funded or completed transactions'],
    validate: {
      validator: async function (value) {
        if (!value) return false;
        const wallet = await mongoose.model('Wallet').findById(value);
        return !!wallet;
      },
      message: 'Invalid or missing seller wallet',
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

transactionSchema.index({ transactionId: 1 }, { unique: true });

transactionSchema.pre('save', async function (next) {
  if (this.status === 'completed' || this.funded) {
    if (!this.buyerWalletId || !this.sellerWalletId) {
      return next(new Error('Buyer and seller wallets are required for funded or completed transactions'));
    }
  }
  if (this.buyerConfirmed && this.sellerConfirmed && this.status !== 'completed') {
    this.status = 'completed';
  }
  next();
});

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;