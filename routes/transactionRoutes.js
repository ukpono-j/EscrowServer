const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const authenticateUser = require('../middlewares/authenticateUser');
const { body, validationResult } = require('express-validator');
const Transaction = require('../modules/Transactions');
const mongoose = require('mongoose');
const Chatroom = require("../modules/Chatroom");
const upload = require('../middlewares/upload'); 


// Middleware to validate input
const validateInput = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ errors: errors.array() });
    }
    next();
};


// Example validation configurations for different routes
router.post('/create-transaction',
    authenticateUser,
    [
        body('paymentName').notEmpty().withMessage('name is required'),
        body('email').notEmpty().withMessage('email is required'),
        body('paymentAmount').notEmpty().isNumeric().withMessage('Amount must be a number'),
        body('paymentName').notEmpty().withMessage('paymentName is required'),
        body('paymentBank').notEmpty().withMessage('Payment Bank Name is required'),
        body('paymentAccountNumber').notEmpty().isNumeric().withMessage('bank number must be a number'),
        body('paymentDescription').notEmpty().withMessage('Description is required'),
        // Add more validations as needed
    ],
    validateInput,
    transactionController.createTransaction
);

// router.post('/create-transaction', authenticateUser, transactionController.createTransaction);
router.get('/get-transaction', authenticateUser, transactionController.getUserTransactions);

router.put('/complete-transaction/:transactionId', authenticateUser, transactionController.completeTransaction);
router.get('/complete-transaction', authenticateUser, transactionController.getCompletedTransactions);

router.put("/cancel/:transactionId",authenticateUser, transactionController.cancelTransaction);

router.post('/join-transaction', authenticateUser, transactionController.joinTransaction);

//============================ Update Payment Status ================================
router.post('/update-payment-status', authenticateUser, transactionController.updatePaymentStatus);

// ======================= Create Chat Room Endpoint ================================
router.post('/create-chatroom', authenticateUser, transactionController.createChatRoom);


// samething here, I will have to look at the endpoint to be sure that they are not doing the samething as the waybill endpoints
router.get("/:id", authenticateUser, transactionController.getTransactionById);

// router.post("/submit-waybill", authenticateUser, transactionController.submitWaybillDetails);
router.post('/submit-waybill',authenticateUser, upload.single('image'), transactionController.submitWaybillDetails);

// Add this route to get waybill details /// rememeber to remove this, it feels like different endpoints doing the samething.
router.get('/waybill-details/:transactionId', authenticateUser, transactionController.getWaybillDetails);

// Add this route
router.get('/chatroom/:chatroomId', authenticateUser, transactionController.getTransactionByChatroomId);

module.exports = router;


