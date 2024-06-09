const express = require('express');
const { getMessages, addMessage } = require('../controllers/messageController');

const router = express.Router();

router.get('/:chatroomId', getMessages);
router.post('/send-message', addMessage);

module.exports = router;
