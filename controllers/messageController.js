const mongoose = require('mongoose');
const Transaction = require('../modules/Transactions');
const Chatroom = require('../modules/Chatroom');
const User = require('../modules/Users');
const Message = require('../modules/Message');
const transactionController = require('./transactionController');
const notificationController = require('./notificationController'); // Ensure this is imported

exports.addMessage = async (req, res) => {
  const { transactionId, userId, userFirstName, message, avatarSeed } = req.body;
  console.log('Adding message:', { transactionId, userId, userFirstName, message });

  try {
    // Validate input
    if (!transactionId || !userId || !message) {
      console.warn('Missing required fields:', req.body);
      return res.status(400).json({ message: 'Missing required fields: transactionId, userId, and message are required' });
    }

    // Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.warn('Invalid transactionId format:', transactionId);
      return res.status(400).json({ message: 'Invalid transaction ID format' });
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      console.warn('Invalid userId format:', userId);
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    // Fetch user details
    const user = await User.findById(userId).select('firstName lastName avatarSeed');
    if (!user) {
      console.warn('User not found:', userId);
      return res.status(404).json({ message: 'User not found' });
    }

    // Find transaction with populated participants
    const transaction = await Transaction.findById(transactionId)
      .populate('participants.userId', 'firstName lastName email avatarSeed');
    if (!transaction) {
      console.warn('Transaction not found:', transactionId);
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Validate user is a participant
    const isParticipant =
      transaction.userId.toString() === userId ||
      (Array.isArray(transaction.participants) && transaction.participants.some(p => p.userId && p.userId._id.toString() === userId));
    if (!isParticipant) {
      console.warn('Unauthorized user:', { userId, transactionId });
      return res.status(403).json({ message: 'Unauthorized to send messages in this transaction' });
    }

    // Get or create chatroom
    let chatroom = transaction.chatroomId ? await Chatroom.findById(transaction.chatroomId) : null;
    if (!chatroom) {
      console.log('Chatroom not found, creating new one for transaction:', transactionId);
      const chatroomResponse = await transactionController.createChatRoom(
        { body: { transactionId }, user: { id: userId }, app: req.app },
        {
          json: (data) => data,
          status: (code) => ({
            json: (data) => ({ code, data }),
          }),
        }
      );

      if (!chatroomResponse || !chatroomResponse.chatroomId) {
        console.error('createChatRoom did not return a valid chatroomId:', chatroomResponse);
        return res.status(500).json({ message: 'Failed to create chatroom', details: 'Invalid chatroom creation response' });
      }

      chatroom = await Chatroom.findById(chatroomResponse.chatroomId);
      if (!chatroom) {
        console.error('Created chatroom not found:', chatroomResponse.chatroomId);
        return res.status(500).json({ message: 'Failed to retrieve created chatroom' });
      }
    }

    // Create and save the message
    const newMessage = new Message({
      chatroomId: chatroom._id,
      userId: new mongoose.Types.ObjectId(userId),
      userFirstName: user.firstName || userFirstName || 'User',
      userLastName: user.lastName || '',
      message: message.trim(),
      avatarSeed: user.avatarSeed || avatarSeed || userId,
      timestamp: new Date(),
    });

    await newMessage.save();
    console.log('Message saved to database:', JSON.stringify(newMessage, null, 2));

    // Create a notification for the message
    const participants = transaction.participants.map(p => ({
      userId: p.userId._id,
      role: p.role,
    }));
    const notificationData = {
      title: `New Message from ${user.firstName || 'User'} ${user.lastName || ''}`.trim(),
      message: message.trim().length > 50 ? `${message.trim().substring(0, 47)}...` : message.trim(),
      transactionId: transaction._id,
      chatroomId: chatroom._id, // Ensure chatroomId is included
      participants,
      type: 'message',
      userId,
    };

    console.log('Creating notification:', JSON.stringify(notificationData, null, 2));
    const notificationResponse = await notificationController.createNotification(
      { body: notificationData, user: { id: userId }, app: req.app },
      {
        json: (data) => data,
        status: (code) => ({
          json: (data) => ({ code, data }),
        }),
      }
    );

    if (!notificationResponse || !notificationResponse.data) {
      console.error('Failed to create notification:', notificationResponse);
    } else {
      console.log('Notification created successfully:', notificationResponse.data._id);
    }

    // Emit the message via Socket.io
    const io = req.app.get('io');
    if (!io) {
      console.error('Socket.io instance not found');
      return res.status(500).json({ message: 'Socket.io instance not available' });
    }
    console.log('Emitting message to room:', `transaction_${chatroom._id}`);
    io.to(`transaction_${chatroom._id}`).emit('message', {
      _id: newMessage._id,
      chatroomId: newMessage.chatroomId,
      userId: newMessage.userId,
      userFirstName: newMessage.userFirstName,
      userLastName: newMessage.userLastName,
      message: newMessage.message,
      avatarSeed: newMessage.avatarSeed,
      timestamp: newMessage.timestamp,
    });

    return res.status(201).json(newMessage);
  } catch (error) {
    console.error('Error adding message:', {
      transactionId: req.body.transactionId,
      userId: req.body.userId,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ message: 'Failed to add message', details: error.message });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    console.log('Fetching messages for chatroom:', chatroomId);

    // Validate chatroomId
    if (!mongoose.Types.ObjectId.isValid(chatroomId)) {
      console.warn('Invalid chatroomId format:', chatroomId);
      return res.status(400).json({ error: 'Invalid chatroom ID format' });
    }

    // Find chatroom
    const chatroom = await Chatroom.findById(chatroomId);
    if (!chatroom) {
      console.warn('Chatroom not found:', chatroomId);
      return res.status(404).json({ error: 'Chatroom not found' });
    }

    // Find transaction with populated participants
    const transaction = await Transaction.findById(chatroom.transactionId)
      .populate('participants.userId', 'firstName lastName email avatarSeed');
    if (!transaction) {
      console.warn('Transaction not found for chatroom:', { chatroomId, transactionId: chatroom.transactionId });
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Verify chatroomId in transaction
    if (!transaction.chatroomId || transaction.chatroomId.toString() !== chatroomId) {
      console.warn('Chatroom ID mismatch in transaction:', {
        transactionId: transaction._id,
        transactionChatroomId: transaction.chatroomId,
        requestedChatroomId: chatroomId,
      });
      return res.status(400).json({ error: 'Chatroom ID does not match transaction' });
    }

    // Verify user access
    const userId = req.user?.id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      console.warn('Invalid or missing userId:', userId);
      return res.status(401).json({ error: 'Invalid or missing user authentication' });
    }

    // Check if user is a participant
    const isParticipant =
      transaction.userId.toString() === userId ||
      (Array.isArray(transaction.participants) && transaction.participants.some(p => p.userId && p.userId._id.toString() === userId));
    if (!isParticipant) {
      console.warn('Unauthorized access:', { userId, chatroomId, transactionId: transaction._id });
      return res.status(403).json({ error: 'Unauthorized to view messages' });
    }

    // Fetch messages with populated userId
    const messages = await Message.find({ chatroomId: new mongoose.Types.ObjectId(chatroomId) })
      .populate('userId', 'firstName lastName email avatarSeed')
      .sort({ timestamp: 1 })
      .lean();

    console.log(`Fetched ${messages.length} messages for chatroom ${chatroomId}:`, JSON.stringify(messages, null, 2));
    return res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching messages:', {
      chatroomId: req.params.chatroomId,
      userId: req.user?.id,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
};

module.exports = exports;