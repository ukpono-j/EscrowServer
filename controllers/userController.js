const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../modules/Users');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cloudinary = require('cloudinary').v2;

axiosRetry(axios, {
  retries: 5,
  retryDelay: (retryCount) => {
    console.log(`Retry attempt ${retryCount} for Paystack API at ${new Date().toISOString()}`);
    return retryCount * 2000;
  },
  retryCondition: (error) => {
    const isRetryable =
      error.code === 'ECONNABORTED' ||
      error.code === 'ERR_NETWORK' ||
      (error.response && error.response.status >= 500) ||
      (error.response && error.response.status === 429);
    console.log('Retry condition check:', {
      code: error.code,
      status: error.response?.status,
      isRetryable,
    });
    return isRetryable;
  },
});

let transporter;

if (process.env.NODE_ENV === 'production') {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
} else {
  transporter = null;
}

const setupEtherealAccount = async () => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    const testTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
    });
    return testTransporter;
  } catch (error) {
    console.error('Error creating Ethereal account:', error);
    return {
      sendMail: (mailOptions) => {
        return Promise.resolve({ messageId: 'fake-message-id' });
      },
    };
  }
};

exports.getUserDetails = async (req, res) => {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const { id: userId } = req.user;
      console.log('Fetching user details:', { userId, attempt: attempt + 1 });
      const user = await User.findById(userId).select('-password');
      if (!user) {
        console.log('User not found:', userId);
        return res.status(404).json({ error: 'User not found' });
      }
      const userWithAvatar = {
        ...user.toObject(),
        avatarImage: user.avatarImage || null,
      };
      console.log('Sending user details response:', { userId, avatarImage: userWithAvatar.avatarImage });
      return res.status(200).json({ success: true, data: { user: userWithAvatar } });
    } catch (error) {
      attempt++;
      console.error('Error in getUserDetails:', {
        userId: req.user?.id,
        message: error.message,
        stack: error.stack,
        attempt,
      });
      if (error.code === 'ECONNRESET' && attempt < maxRetries) {
        console.log(`Retrying getUserDetails (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
  }
};

exports.getAllUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    console.log('Fetching all users:', { userId });
    const users = await User.find({ _id: { $ne: userId } }).select(['email', 'firstName', '_id', 'avatarImage']);
    if (!users || users.length === 0) {
      console.log('No other users found:', userId);
      return res.status(404).json({ error: 'No other users found' });
    }
    const usersWithAvatars = users.map(user => ({
      ...user.toObject(),
      avatarImage: user.avatarImage || null,
    }));
    res.status(200).json({ success: true, data: { users: usersWithAvatars } });
  } catch (error) {
    console.error('Error in getAllUserDetails:', {
      userId: req.user.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

exports.updateUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { firstName, lastName, dateOfBirth, bank, accountNumber, phoneNumber } = req.body;
    console.log('Updating user details:', { 
      userId, 
      firstName, 
      lastName, 
      dateOfBirth, 
      bank, 
      accountNumber, 
      phoneNumber,
      hasFile: !!req.file,
      fileDetails: req.file ? { 
        filename: req.file.originalname, 
        size: req.file.size, 
        mimetype: req.file.mimetype,
        bufferExists: !!req.file.buffer 
      } : null,
    });

    const user = await User.findById(userId);
    if (!user) {
      console.log('User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }

    // Validate required fields
    if (!firstName || !lastName || !phoneNumber) {
      console.warn('Missing required fields:', { firstName, lastName, phoneNumber });
      return res.status(400).json({ success: false, error: 'First name, last name, and phone number are required' });
    }

    // Update user fields
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.dateOfBirth = dateOfBirth || user.dateOfBirth;
    user.bank = bank || user.bank;
    user.accountNumber = accountNumber || user.accountNumber;
    user.phoneNumber = phoneNumber || user.phoneNumber;

    // Handle file upload to Cloudinary
    if (req.file) {
      try {
        const uploadImage = (buffer) => new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream({
            folder: 'avatars',
            allowed_formats: ['jpg', 'png'],
            public_id: `avatar_${userId}_${Date.now()}`,
          }, (error, result) => {
            if (error) return reject(error);
            resolve(result);
          });
          uploadStream.end(buffer);
        });

        const result = await uploadImage(req.file.buffer);
        console.log('New avatar uploaded to Cloudinary:', result.secure_url);

        // Delete old avatar from Cloudinary if it exists
        if (user.avatarImage && user.avatarImage.startsWith('https://res.cloudinary.com')) {
          const parts = user.avatarImage.split('/');
          const publicId = parts[parts.length - 1].split('.')[0];
          const folderPublicId = `avatars/${publicId}`;
          try {
            await cloudinary.uploader.destroy(folderPublicId);
            console.log('Deleted old avatar from Cloudinary:', folderPublicId);
          } catch (deleteError) {
            console.warn('Failed to delete old Cloudinary image:', folderPublicId, deleteError.message);
          }
        }

        user.avatarImage = result.secure_url;
      } catch (uploadError) {
        console.error('Cloudinary upload error:', uploadError.message, uploadError.stack);
        return res.status(500).json({ success: false, error: `Failed to upload avatar to Cloudinary: ${uploadError.message}` });
      }
    }

    await user.save();
    const userWithAvatar = {
      ...user.toObject(),
      avatarImage: user.avatarImage || null,
    };
    console.log('User details updated successfully:', { userId, avatarImage: userWithAvatar.avatarImage });
    res.status(200).json({ success: true, data: { message: 'User details updated successfully!', user: userWithAvatar } });

    // Emit socket event for profile update
    try {
      const io = req.app.get('io');
      io.to(`user_${userId}`).emit('profileUpdated', {
        userId,
        message: 'Profile updated successfully',
        avatarImage: user.avatarImage,
      });
      console.log('Socket event emitted for profile update:', userId);
    } catch (socketError) {
      console.warn('Socket event emission failed:', socketError.message);
    }
  } catch (error) {
    console.error('Error in updateUserDetails:', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
    });
    let errorMessage = 'Failed to update user details';
    if (error.message.includes('Cloudinary')) {
      errorMessage = `Cloudinary error: ${error.message}`;
    } else if (error.message.includes('MongoDB') || error.message.includes('User')) {
      errorMessage = `Database error: ${error.message}`;
    }
    res.status(500).json({ success: false, error: errorMessage });
  }
};

exports.getAvatar = async (req, res) => {
  try {
    const { filename } = req.params;
    console.log('Serving avatar:', { filename });
    const user = await User.findOne({ avatarImage: { $regex: filename, $options: 'i' } });
    if (!user || !user.avatarImage || !user.avatarImage.startsWith('https://res.cloudinary.com')) {
      console.log('Avatar not found or not a Cloudinary URL:', { filename });
      return res.status(404).json({ error: 'Avatar not found' });
    }
    // Redirect to Cloudinary URL
    res.redirect(user.avatarImage);
  } catch (error) {
    console.error('Error serving avatar:', {
      filename: req.params.filename,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to serve avatar' });
  }
};