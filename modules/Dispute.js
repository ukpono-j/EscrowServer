// Updated Dispute.js schema to include 'Cancelled'
const mongoose = require('mongoose');

const disputeSchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  reason: {
    type: String,
    enum: ['Non-delivery', 'Incomplete service', 'Wrong item', 'Other'],
    required: true,
  },
  description: {
    type: String,
    required: true,
    trim: true,
  },
  evidence: [{
    url: String,
    publicId: String,
  }],
  status: {
    type: String,
    enum: ['Open', 'Under Review', 'Resolved', 'Rejected', 'Cancelled'],
    default: 'Open',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  assignedModerator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
});

disputeSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Dispute', disputeSchema);