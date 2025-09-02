// userController.js
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
const path = require('path');
const fs = require('fs');
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
        avatarImage: user.avatarImage
          ? (user.avatarImage.startsWith('https://') ? user.avatarImage : `/Uploads/images/${user.avatarImage}`)
          : '/Uploads/images/default-avatar.png',
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
      avatarImage: user.avatarImage
        ? (user.avatarImage.startsWith('https://') ? user.avatarImage : `/Uploads/images/${user.avatarImage}`)
        : '/Uploads/images/default-avatar.png',
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
    const { firstName, lastName, dateOfBirth, bank, accountNumber } = req.body;
    console.log('Updating user details:', { userId, firstName, lastName, dateOfBirth, bank, accountNumber, file: req.file?.originalname });

    const user = await User.findById(userId);
    if (!user) {
      console.log('User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }

    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.dateOfBirth = dateOfBirth || user.dateOfBirth;
    user.bank = bank || user.bank;
    user.accountNumber = accountNumber || user.accountNumber;

    if (req.file) {
      // Upload to Cloudinary
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

      // Delete old avatar from Cloudinary if it exists
      if (user.avatarImage && user.avatarImage.startsWith('https://res.cloudinary.com')) {
        const parts = user.avatarImage.split('/');
        const publicId = parts[parts.length - 1].split('.')[0];
        const folderPublicId = `avatars/${publicId}`;
        await cloudinary.uploader.destroy(folderPublicId);
        console.log('Deleted old avatar from Cloudinary:', folderPublicId);
      }

      user.avatarImage = result.secure_url;
      console.log('New avatar uploaded to Cloudinary:', user.avatarImage);
    }

    await user.save();
    const userWithAvatar = {
      ...user.toObject(),
      avatarImage: user.avatarImage
        ? (user.avatarImage.startsWith('https://') ? user.avatarImage : `/Uploads/images/${user.avatarImage}`)
        : '/Uploads/images/default-avatar.png',
    };
    console.log('User details updated successfully:', { userId, avatarImage: userWithAvatar.avatarImage });
    res.status(200).json({ success: true, data: { message: 'User details updated successfully!', user: userWithAvatar } });
  } catch (error) {
    console.error('Error in updateUserDetails:', {
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

exports.getAvatar = async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, '..', 'Uploads', 'images', filename);
    console.log('Serving avatar:', { filePath });
    if (!fs.existsSync(filePath)) {
      console.log('Avatar file not found:', filePath);
      return res.status(404).json({ error: 'Avatar not found' });
    }
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving avatar:', {
      filename: req.params.filename,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to serve avatar' });
  }
};