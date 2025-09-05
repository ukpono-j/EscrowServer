const mongoose = require("mongoose");

const KYCSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  bvn: {
    type: String,
    required: true,
    match: [/^\d{11}$/, "BVN must be an 11-digit number"],
  },
  verificationResult: {
    firstName: { type: String },
    lastName: { type: String },
    dateOfBirth: { type: Date },
    status: { type: String, enum: ["VERIFIED", "NOT_VERIFIED"], default: "NOT_VERIFIED" },
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

module.exports = mongoose.models.KYC || mongoose.model('KYC', KYCSchema);