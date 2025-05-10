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

module.exports = router;