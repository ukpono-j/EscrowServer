
const mongoose = require('mongoose');
const Notification = require('../modules/Notification');
const Transaction = require('../modules/Transactions');
const User = require('../modules/Users');
const webpush = require('web-push');

const validNotificationTypes = ['transaction', 'funding', 'confirmation', 'payment', 'waybill', 'registration', 'message'];

exports.acceptTransaction = async (req, res) => {
  try {
    const { notificationId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).json({ success: false, error: 'Invalid notificationId' });
    }

    const updatedNotification = await Notification.findByIdAndUpdate(
      notificationId,
      { status: 'accepted', isRead: true },
      { new: true }
    );
    if (!updatedNotification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    res.status(200).json({ success: true, data: updatedNotification });
  } catch (error) {
    console.error('Error in acceptTransaction:', {
      error: error.message,
      stack: error.stack,
      notificationId: req.body.notificationId,
    });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.declineTransaction = async (req, res) => {
  try {
    const { notificationId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).json({ success: false, error: 'Invalid notificationId' });
    }

    const updatedNotification = await Notification.findByIdAndUpdate(
      notificationId,
      { status: 'declined', isRead: true },
      { new: true }
    );
    if (!updatedNotification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    res.status(200).json({ success: true, data: updatedNotification });
  } catch (error) {
    console.error('Error in declineTransaction:', {
      error: error.message,
      stack: error.stack,
      notificationId: req.body.notificationId,
    });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const { id: userId } = req.user;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      console.error('Invalid userId:', userId);
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    const transactions = await Transaction.find({
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
        { 'participants.userId': new mongoose.Types.ObjectId(userId) },
      ],
    }).select('_id').lean();

    const transactionIds = transactions.map((transaction) => transaction._id.toString());
    console.log('Fetched transaction IDs:', transactionIds);

    const allNotifications = await Notification.find({
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
        { 'participants.userId': new mongoose.Types.ObjectId(userId) },
        { transactionId: { $in: transactionIds.map(id => new mongoose.Types.ObjectId(id)) } },
      ],
    })
      .populate('userId', 'firstName lastName email avatarSeed')
      .populate('transactionId', 'selectedUserType paymentAmount status')
      .sort({ timestamp: -1 })
      .lean();

    console.log('Notifications fetched:', allNotifications.length);
    res.status(200).json({ success: true, data: allNotifications });
  } catch (error) {
    console.error('Error fetching notifications:', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
      query: JSON.stringify({
        userId: req.user?.id,
        participants: { userId: req.user?.id },
        transactionIds: 'derived from Transaction query',
      }),
    });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.createNotification = async (req, res) => {
  try {
    const { title, message, transactionId, participants, type, chatroomId } = req.body;
    const { id: userId } = req.user;

    // Validate inputs
    if (!title || !message || !transactionId) {
      return res.status(400).json({ success: false, error: 'Title, message, and transactionId are required' });
    }
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      return res.status(400).json({ success: false, error: 'Invalid transactionId' });
    }
    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ success: false, error: 'Participants array is required and must not be empty' });
    }
    if (type && !validNotificationTypes.includes(type)) {
      return res.status(400).json({ success: false, error: `Invalid notification type. Must be one of: ${validNotificationTypes.join(', ')}` });
    }
    if (type === 'message' && (!chatroomId || !mongoose.Types.ObjectId.isValid(chatroomId))) {
      return res.status(400).json({ success: false, error: 'Invalid or missing chatroomId for message notification' });
    }

    const validRoles = ['buyer', 'seller'];
    const validatedParticipants = participants.map(p => {
      if (!mongoose.Types.ObjectId.isValid(p.userId)) {
        throw new Error(`Invalid userId in participants: ${p.userId}`);
      }
      if (!validRoles.includes(p.role)) {
        throw new Error(`Invalid role in participants: ${p.role}. Must be 'buyer' or 'seller'`);
      }
      return {
        userId: new mongoose.Types.ObjectId(p.userId),
        role: p.role,
      };
    });

    const newNotification = new Notification({
      userId: new mongoose.Types.ObjectId(userId),
      title,
      message,
      transactionId: new mongoose.Types.ObjectId(transactionId),
      chatroomId: type === 'message' ? new mongoose.Types.ObjectId(chatroomId) : undefined,
      participants: validatedParticipants,
      type: type || 'transaction',
      isRead: false,
      timestamp: new Date(),
    });

    await newNotification.save();
    console.log('Notification created:', newNotification._id);

    // Send push notifications
    const recipients = [
      newNotification.userId.toString(),
      ...newNotification.participants.map(p => p.userId.toString()),
    ].filter(id => id !== userId); // Exclude sender
    const uniqueRecipients = [...new Set(recipients)];

    for (const recipientId of uniqueRecipients) {
      try {
        const user = await User.findById(recipientId);
        if (user && user.pushSubscriptions?.length > 0) {
          const payload = JSON.stringify({
            title: newNotification.title,
            body: newNotification.message,
            icon: '/icons/android-chrome-192x192.png',
            data: {
              url: type === 'message' ? `/chat/${newNotification.chatroomId}` : `/transactions/tab?transactionId=${newNotification.transactionId}`,
              notificationId: newNotification._id.toString(),
              chatroomId: type === 'message' ? newNotification.chatroomId.toString() : undefined,
            },
          });

          for (let i = 0; i < user.pushSubscriptions.length; i++) {
            const sub = user.pushSubscriptions[i];
            try {
              await webpush.sendNotification(sub, payload);
              console.log('Push notification sent to:', recipientId);
            } catch (pushError) {
              if (pushError.statusCode === 410 || pushError.statusCode === 404) {
                console.log('Removing expired subscription for user:', recipientId);
                user.pushSubscriptions.splice(i, 1);
                await user.save();
                i--;
              } else {
                console.error('Push send error for user:', recipientId, pushError);
              }
            }
          }
        } else {
          console.log('No push subscriptions found for user:', recipientId);
        }
      } catch (error) {
        console.error('Push notification error for user:', recipientId, error);
      }
    }

    // Emit WebSocket event for real-time updates
    const io = req.app.get('io');
    uniqueRecipients.forEach(recipientId => {
      console.log('Emitting newNotification to:', `user_${recipientId}`);
      io.to(`user_${recipientId}`).emit('newNotification', {
        _id: newNotification._id,
        title: newNotification.title,
        message: newNotification.message,
        transactionId: newNotification.transactionId,
        chatroomId: type === 'message' ? newNotification.chatroomId : undefined,
        type: newNotification.type,
        status: newNotification.status,
        isRead: newNotification.isRead,
        userId: newNotification.userId,
        participants: newNotification.participants,
        timestamp: newNotification.timestamp,
      });
    });

    res.status(200).json({ success: true, data: newNotification });
  } catch (error) {
    console.error('Error creating notification:', {
      error: error.message,
      stack: error.stack,
      body: req.body,
      userId: req.user?.id,
    });
    res.status(400).json({ success: false, error: error.message || 'Invalid notification data' });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid notification ID' });
    }

    const notification = await Notification.findOne({ _id: id, userId });
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found or unauthorized' });
    }
    await Notification.deleteOne({ _id: id });
    console.log('Notification deleted:', id);

    // Notify via WebSocket
    const io = req.app.get('io');
    io.to(`user_${userId}`).emit('notificationDeleted', { id });

    res.status(200).json({ success: true, message: 'Notification deleted successfully' });
  } catch (error) {
    console.error('Error deleting notification:', {
      error: error.message,
      stack: error.stack,
      notificationId: req.params.id,
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.updateNotificationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, isRead } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid notification ID' });
    }

    const updateFields = {};
    if (status) {
      const validStatuses = ['pending', 'accepted', 'declined', 'completed', 'canceled', 'failed', 'error', 'warning', 'funded'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid status' });
      }
      updateFields.status = status;
    }
    if (typeof isRead === 'boolean') {
      updateFields.isRead = isRead;
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const notification = await Notification.findOne({ _id: id, userId });
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found or unauthorized' });
    }

    Object.assign(notification, updateFields);
    await notification.save();
    console.log('Notification updated:', { id, ...updateFields });

    // Notify via WebSocket
    const io = req.app.get('io');
    io.to(`user_${userId}`).emit('notificationUpdated', {
      id,
      ...updateFields,
    });

    res.status(200).json({ success: true, data: notification });
  } catch (error) {
    console.error('Error updating notification:', {
      error: error.message,
      stack: error.stack,
      notificationId: req.params.id,
      body: req.body,
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

module.exports = exports;
