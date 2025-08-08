const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');

// Define User schema without importing the model directly
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  dateOfBirth: { type: Date, required: true },
  password: { type: String, required: true, select: false },
  isAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  avatarSeed: { type: String, default: () => require('uuid').v4() },
});

// Add comparePassword method
userSchema.methods.comparePassword = async function (candidatePassword) {
  console.log('Comparing password for user:', this.email);
  const isMatch = await bcrypt.compare(candidatePassword, this.password);
  console.log('Password comparison result:', isMatch);
  return isMatch;
};

// Modify pre('save') hook to respect _skipPasswordHash
userSchema.pre('save', async function (next) {
  if (this.isModified('password') && !this._skipPasswordHash) {
    console.log('Hashing password for user:', this.email);
    this.password = await bcrypt.hash(this.password, 10);
    console.log('Password hashed successfully for user:', this.email);
    if (this.isNew) {
      const existingUser = await this.constructor.findOne({ avatarSeed: this.avatarSeed });
      if (existingUser) this.avatarSeed = require('uuid').v4();
    }
  }
  next();
});

const User = mongoose.model('User', userSchema);

dotenv.config();
console.log('MONGODB_URI:', process.env.MONGODB_URI);

const createAdmin = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in .env file');
    }
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('Connected to MongoDB');

    const email = 'sylo@gmail.com';
    const password = 'sylopays@@';
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('Hashed password:', hashedPassword);

    await User.deleteOne({ email });
    console.log('Deleted existing user with email:', email);

    const user = new User({
      firstName: 'Sylo',
      lastName: 'Admin',
      email,
      phoneNumber: '1234567890',
      dateOfBirth: new Date('1990-01-01'),
      password: hashedPassword,
      isAdmin: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    user._skipPasswordHash = true;
    await user.save();
    console.log('Admin user created:', email);
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin:', error.message);
    process.exit(1);
  }
};

createAdmin();