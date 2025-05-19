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
    console.error(error);
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
    console.error(error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Fetch transactions where the user is a participant or creator
    const transactions = await Transaction.find({
      $or: [{ userId }, { participants: userId }],
    }).select('_id'); // Only select _id to reduce data load

    const transactionIds = transactions.map((transaction) => transaction._id.toString());

    // Fetch all relevant notifications in one query
    const allNotifications = await Notification.find({
      $or: [
        { userId }, // Creator notifications
        { "participants.userId": userId }, // Participant notifications
        { transactionId: { $in: transactionIds } }, // Notifications for joined transactions
      ],
    })
      .sort({ timestamp: -1 }) // Sort by timestamp descending
      .lean(); // Use lean to improve performance by converting to plain JS object

    console.log('Notifications fetched:', allNotifications.length);
    res.status(200).json({ success: true, data: allNotifications });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

exports.createNotification = async (req, res) => {
  try {
    const { title, message, transactionId } = req.body; // transactionId should be _id string
    const { id: userId } = req.user;

    if (!title || !message || !transactionId) {
      return res.status(400).json({ success: false, error: "Title, message, and transactionId are required" });
    }

    const newNotification = new Notification({
      userId,
      title,
      message,
      transactionId, // Now expects _id as a string
    });

    await newNotification.save();
    res.status(200).json({ success: true, data: newNotification });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const notification = await Notification.findOne({ _id: id, userId });
    if (!notification) {
      return res.status(404).json({ success: false, error: "Notification not found or unauthorized" });
    }
    await Notification.deleteOne({ _id: id });
    res.status(200).json({ success: true, message: "Notification deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

exports.updateNotificationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user.id;
    const notification = await Notification.findOne({ _id: id, userId });
    if (!notification) {
      return res.status(404).json({ success: false, error: "Notification not found or unauthorized" });
    }
    notification.status = status;
    await notification.save();
    res.status(200).json({ success: true, data: notification });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};