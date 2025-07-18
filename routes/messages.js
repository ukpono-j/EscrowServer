// messageRoutes.js
const express = require('express');
const router = express.Router();
const { getMessages, addMessage } = require('../controllers/messageController');
const authenticateUser = require('../middlewares/authenticateUser');

router.get('/:chatroomId', authenticateUser, getMessages);
router.post('/send-message', authenticateUser, addMessage);

module.exports = router;