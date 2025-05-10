const NotificationVerification = require('../modules/NotificationVerification');
const Notification = require('../modules/Notification');
const Transaction = require('../modules/Transactions');


exports.acceptTransaction = async (req, res) => {
  try {
    const { notificationId } = req.body;
    const updatedNotification = await NotificationVerification.findByIdAndUpdate(
      notificationId,
      { status: 'accepted' },
      { new: true }
    );
    res.status(200).json(updatedNotification);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.declineTransaction = async (req, res) => {
  try {
    const { notificationId } = req.body;
    const updatedNotification = await NotificationVerification.findByIdAndUpdate(
      notificationId,
      { status: 'declined' },
      { new: true }
    );
    res.status(200).json(updatedNotification);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};



exports.getNotifications = async (req, res) => {
    try {
      const { id: userId } = req.user;
  
      // Fetch notifications where the user is the creator
      const creatorNotifications = await Notification.find({ userId: userId });
  
      // Fetch notifications where the user is a participant
      const participantNotifications = await Notification.find({
        "participants.userId": userId,
      });
  
      // Fetch transactions where the user is a participant
      const joinedTransactions = await Transaction.find({
        "participants.userId": userId,
      });
  
      // Get notifications for joined transactions by transactionId
      const joinedTransactionNotifications = await Notification.find({
        transactionId: {
          $in: joinedTransactions.map((transaction) => transaction.transactionId),
        },
      });
  
      // Combine and return both creator and participant notifications to the client
      const allNotifications = [
        ...creatorNotifications,
        ...participantNotifications,
        ...joinedTransactionNotifications,
      ];
  
      res.status(200).json(allNotifications);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  };
  
  exports.createNotification = async (req, res) => {
    try {
      const { title, message, transactionId } = req.body;
      const { id: userId } = req.user;
  
      if (!title || !message || !transactionId) {
        return res.status(400).json({ error: "Title, message, and transactionId are required" });
      }
  
      // Create a new notification object using the schema
      const newNotification = new Notification({
        userId: userId,
        title,
        message,
        transactionId,
      });
  
      // Save the notification to the database
      await newNotification.save();
  
      // Return success response to the client
      res.status(200).json(newNotification);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  };

  exports.deleteNotification = async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const notification = await Notification.findOne({ _id: id, userId });
      if (!notification) {
        return res.status(404).json({ error: "Notification not found or unauthorized" });
      }
      await Notification.deleteOne({ _id: id });
      res.status(200).json({ message: "Notification deleted successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  };
  
  exports.updateNotificationStatus = async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const userId = req.user.id;
      const notification = await Notification.findOne({ _id: id, userId });
      if (!notification) {
        return res.status(404).json({ error: "Notification not found or unauthorized" });
      }
      notification.status = status;
      await notification.save();
      res.status(200).json(notification);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  };