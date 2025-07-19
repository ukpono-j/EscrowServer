const mongoose = require("mongoose");

const KYCSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  documentType: {
    type: String,
    enum: ["Drivers License", "NIN Slip", "Passport"],
    required: true,
  },
  documentPhoto: {
    type: String,
    required: true,
  },
  personalPhoto: {
    type: String,
    required: true,
  },
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  dateOfBirth: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "not_submitted"],
    default: "pending",
  },
  isSubmitted: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

KYCSchema.index({ user: 1 });
KYCSchema.index({ status: 1 });

module.exports = mongoose.model("KYC", KYCSchema);