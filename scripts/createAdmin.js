const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../modules/Users');
const dotenv = require('dotenv');

dotenv.config();
console.log('MONGODB_URI:', process.env.MONGODB_URI); // Debug line

const createAdmin = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in .env file');
    }
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    const email = 'sylo@gmail.com';
    const password = 'sylopays@@';
    const hashedPassword = await bcrypt.hash(password, 10);

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('Admin user already exists:', email);
      return process.exit(0);
    }

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

    await user.save();
    console.log('Admin user created:', email);
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin:', error.message);
    process.exit(1);
  }
};

createAdmin();