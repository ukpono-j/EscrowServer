const mongoose = require('mongoose');
const Notification = require('../modules/Notification');
const Transaction = require('../modules/Transactions');

exports.acceptTransaction = async (req, res) => {
  try {
    const { notificationId } = req.body;
    const updatedNotification = await Notification.findByIdAndUpdate(
      notificationId,
      { status: 'accepted' },
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
    const updatedNotification = await Notification.findByIdAndUpdate(
      notificationId,
      { status: 'declined' },
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

    // Validate userId
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      console.error('Invalid userId:', userId);
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    // Fetch transactions where the user is a participant or creator
    const transactions = await Transaction.find({
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
        { 'participants.userId': new mongoose.Types.ObjectId(userId) },
      ],
    }).select('_id').lean();

    const transactionIds = transactions.map((transaction) => transaction._id.toString());
    console.log('Fetched transaction IDs:', transactionIds);

    // Fetch notifications
    const allNotifications = await Notification.find({
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) }, // Creator notifications
        { 'participants.userId': new mongoose.Types.ObjectId(userId) }, // Participant notifications
        { transactionId: { $in: transactionIds.map(id => new mongoose.Types.ObjectId(id)) } }, // Transaction-related notifications
      ],
    })
      .populate('userId', 'firstName lastName email avatarSeed') // Populate user details
      .populate('transactionId', 'selectedUserType paymentAmount status') // Populate transaction details
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
    const { title, message, transactionId, participants } = req.body;
    const { id: userId } = req.user;

    if (!title || !message || !transactionId) {
      return res.status(400).json({ success: false, error: 'Title, message, and transactionId are required' });
    }

    // Validate transactionId
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      return res.status(400).json({ success: false, error: 'Invalid transactionId' });
    }

    // Validate participants
    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ success: false, error: 'Participants array is required and must not be empty' });
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
      participants: validatedParticipants,
    });

    await newNotification.save();
    console.log('Notification created:', newNotification._id);
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
    const { status } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid notification ID' });
    }

    const notification = await Notification.findOne({ _id: id, userId });
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found or unauthorized' });
    }
    notification.status = status;
    await notification.save();
    console.log('Notification status updated:', { id, status });
    res.status(200).json({ success: true, data: notification });
  } catch (error) {
    console.error('Error updating notification status:', {
      error: error.message,
      stack: error.stack,
      notificationId: req.params.id,
      status: req.body.status,
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};