const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const authenticateUser = require('../middlewares/authenticateUser');
const Transaction = require('../modules/Transactions');
const mongoose = require('mongoose');
const Chatroom = require("../modules/Chatroom");

router.post('/create-transaction', authenticateUser, transactionController.createTransaction);
router.get('/get-transaction', authenticateUser, transactionController.getUserTransactions);

router.post('/complete-transaction', authenticateUser, transactionController.completeTransaction);
router.get('/complete-transaction', authenticateUser, transactionController.getCompletedTransactions);

router.post('/join-transaction', authenticateUser, transactionController.joinTransaction);


router.post('/update-payment-status', authenticateUser, transactionController.updatePaymentStatus);

router.post('/create-chatroom', authenticateUser, transactionController.createChatRoom);
router.get("/:id", authenticateUser, transactionController.getTransactionById);

// Add this route
router.get('/chatroom/:chatroomId', authenticateUser, transactionController.getTransactionByChatroomId);

module.exports = router;
