const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const authenticateUser = require('../middlewares/authenticateUser');

router.post('/accept-transaction', authenticateUser, notificationController.acceptTransaction);
router.post('/decline-transaction', authenticateUser, notificationController.declineTransaction);
router.get('/notifications', authenticateUser, notificationController.getNotifications);
router.post('/notifications', authenticateUser, notificationController.createNotification);
router.delete('/notifications/:id', authenticateUser, notificationController.deleteNotification);
router.patch('/notifications/:id', authenticateUser, notificationController.updateNotificationStatus);

router.get('/push/public-key', authenticateUser, (req, res) => {
  res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});
router.post('/push/subscribe', authenticateUser, async (req, res) => {
  const { subscription } = req.body;
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    // Avoid duplicates
    const exists = user.pushSubscriptions.some(sub => sub.endpoint === subscription.endpoint);
    if (!exists) {
      user.pushSubscriptions.push(subscription);
      await user.save();
      console.log('Push subscription saved for user:', userId);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Subscription error:', error);
    res.status(500).json({ success: false, error: 'Failed to subscribe' });
  }
});

module.exports = router;