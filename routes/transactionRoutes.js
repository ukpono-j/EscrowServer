const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const authenticateUser = require('../middlewares/authenticateUser');
const { body, validationResult } = require('express-validator');
const upload = require('../middlewares/upload');

const validateInput = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  next();
};

router.post('/create-transaction',
  authenticateUser,
  [
    body('paymentName').notEmpty().withMessage('name is required'),
    body('email').notEmpty().withMessage('email is required'),
    body('paymentAmount').notEmpty().isNumeric().withMessage('Amount must be a number'),
    body('paymentBank').notEmpty().withMessage('Payment Bank Name is required'),
    body('paymentAccountNumber').notEmpty().isNumeric().withMessage('bank number must be a number'),
    body('paymentDescription').notEmpty().withMessage('Description is required'),
  ],
  validateInput,
  transactionController.createTransaction
);

router.get('/get-transaction', authenticateUser, transactionController.getUserTransactions);

router.get('/complete-transaction', authenticateUser, transactionController.getCompletedTransactions);

router.put("/cancel/:transactionId", authenticateUser, transactionController.cancelTransaction);

router.post('/join-transaction', authenticateUser, transactionController.joinTransaction);

router.post('/update-payment-status', authenticateUser, transactionController.updatePaymentStatus);

router.post('/create-chatroom', authenticateUser, transactionController.createChatRoom);

router.get("/:id", authenticateUser, transactionController.getTransactionById);

router.post('/submit-waybill', authenticateUser, upload.single('image'), transactionController.submitWaybillDetails);

router.get('/waybill-details/:transactionId', authenticateUser, transactionController.getWaybillDetails);

router.get('/chatroom/:chatroomId', authenticateUser, transactionController.getTransactionByChatroomId);

router.post('/confirm', authenticateUser, transactionController.confirmTransaction);

router.post('/fund-transaction', authenticateUser, async (req, res) => {
  const { transactionId, amount } = req.body;
  if (!transactionId || !amount) {
    return res.status(400).json({ message: "Transaction ID and amount are required" });
  }
  await transactionController.fundTransactionWithWallet(req, res);
});

router.put('/update-payment-details/:transactionId', authenticateUser, transactionController.updatePaymentDetails);

module.exports = router;