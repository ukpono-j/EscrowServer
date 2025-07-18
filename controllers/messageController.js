const Message = require('../modules/Message');
const Chatroom = require('../modules/Chatroom');
const Transaction = require('../modules/Transactions');
const User = require('../modules/Users'); // Add this line
const transactionController = require('./transactionController');

exports.getMessages = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    console.log('Fetching messages for chatroom:', chatroomId);
    const chatroom = await Chatroom.findById(chatroomId);
    if (!chatroom) {
      console.warn('Chatroom not found:', chatroomId);
      return res.status(404).json({ error: 'Chatroom not found' });
    }
    const messages = await Message.find({ chatroomId })
      .sort({ timestamp: 1 })
      .lean();
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', {
      chatroomId: req.params.chatroomId,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
};

exports.addMessage = async (req, res) => {
  try {
    const { chatroomId, userId, userFirstName, message, avatarImage } = req.body;
    console.log('Adding message:', { chatroomId, userId, userFirstName, message });

    // Validate input
    if (!chatroomId || !userId || !message) {
      console.warn('Missing required fields:', req.body);
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Fetch user details to ensure valid data
    const user = await User.findById(userId).select('firstName lastName avatarSeed');
    if (!user) {
      console.warn('User not found:', userId);
      return res.status(404).json({ message: 'User not found' });
    }

    // Validate chatroom existence or create it
    let chatroom = await Chatroom.findById(chatroomId);
    if (!chatroom) {
      console.warn('Chatroom not found, attempting to create:', chatroomId);
      const transaction = await Transaction.findOne({ chatroomId });
      if (!transaction) {
        console.warn('No transaction found with chatroomId:', chatroomId);
        return res.status(404).json({ message: 'No transaction associated with this chatroom' });
      }
      const chatroomResponse = await transactionController.createChatRoom(
        { body: { transactionId: transaction._id }, user: { id: userId }, app: req.app },
        { json: () => {}, status: () => ({ json: () => {} }) }
      );
      if (!chatroomResponse.success) {
        console.error('Failed to create chatroom:', chatroomResponse.error);
        return res.status(500).json({ message: 'Failed to create chatroom', details: chatroomResponse.error });
      }
      chatroom = await Chatroom.findById(chatroomResponse.chatroomId);
    }

    // Validate user is a participant
    const transaction = await Transaction.findById(chatroom.transactionId);
    if (!transaction) {
      console.warn('Transaction not found:', chatroom.transactionId);
      return res.status(404).json({ message: 'Transaction not found' });
    }
    const isParticipant =
      transaction.userId.toString() === userId ||
      transaction.participants.some((p) => p.toString() === userId);
    if (!isParticipant) {
      console.warn('Unauthorized user:', { userId, chatroomId });
      return res.status(403).json({ message: 'Unauthorized to send messages in this chatroom' });
    }

    // Create and save the message with validated user data
    const newMessage = new Message({
      chatroomId,
      userId,
      userFirstName: user.firstName || 'User',
      userLastName: user.lastName || '',
      message,
      avatarSeed: user.avatarSeed || userId,
      timestamp: new Date(),
    });
    await newMessage.save();

    // Emit the message via Socket.io
    const io = req.app.get('io');
    if (io) {
      console.log('Emitting message to room:', `transaction_${chatroomId}`);
      io.to(`transaction_${chatroomId}`).emit('message', {
        _id: newMessage._id,
        chatroomId: newMessage.chatroomId,
        userId: newMessage.userId,
        userFirstName: newMessage.userFirstName,
        userLastName: newMessage.userLastName,
        message: newMessage.message,
        avatarSeed: newMessage.avatarSeed,
        timestamp: newMessage.timestamp,
      });
    } else {
      console.error('Socket.io instance not found');
    }

    console.log('Message saved and emitted:', newMessage._id);
    res.status(201).json(newMessage);
  } catch (error) {
    console.error('Error adding message:', {
      chatroomId: req.body.chatroomId,
      userId: req.body.userId,
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to add message', details: error.message });
  }
};