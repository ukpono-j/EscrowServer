const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    select: false,
  },
  dateOfBirth: {
    type: Date,
    required: true,
  },
  phoneNumber: {
    type: String,
    default: '',
  },
  bank: {
    type: String,
    default: '',
  },
  accountNumber: {
    type: String,
    default: '',
  },
  avatarImage: {
    type: String,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.pre('save', async function (next) {
  if (this.isModified('password')) {
    console.log('Hashing password for user:', this.email);
    this.password = await bcrypt.hash(this.password, 10);
    console.log('Password hashed successfully for user:', this.email);
  }
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  console.log('Comparing password for user:', this.email);
  const isMatch = await bcrypt.compare(candidatePassword, this.password);
  console.log('Password comparison result:', isMatch);
  return isMatch;
};

module.exports = mongoose.model('User', userSchema);