const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the User model
    required: true,
  },
  documentType: {
    type: String,
    enum: ['Drivers License', 'Nin Slip', 'Passport'],
    required: true,
  },
  documentPhoto: {
    type: String, // Assuming you store the file path or URL
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
  isSubmitted: {
    type: Boolean,
    default: false,
  },
});

const KYC = mongoose.model('KYC', kycSchema);

module.exports = KYC;
