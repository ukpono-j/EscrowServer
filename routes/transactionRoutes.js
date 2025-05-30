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

router.post(
  "/create-transaction",
  authenticateUser,
  [
    body("email").notEmpty().withMessage("Email is required"),
    body("paymentAmount").notEmpty().isNumeric().withMessage("Amount must be a number"),
    body("paymentDescription").notEmpty().withMessage("Product description is required"),
    body("selectedUserType").notEmpty().isIn(["buyer", "seller"]).withMessage("Invalid user type"),
    body("paymentBank")
      .if(body("selectedUserType").equals("seller"))
      .notEmpty()
      .withMessage("Payment bank is required for sellers"),
    body("paymentAccountNumber")
      .if(body("selectedUserType").equals("seller"))
      .notEmpty()
      .isString()
      .isLength({ min: 10, max: 10 })
      .withMessage("Account number must be a 10-digit string for sellers"),
    body("paymentBankCode")
      .if(body("selectedUserType").equals("seller"))
      .notEmpty()
      .withMessage("Bank code is required for sellers"),
  ],
  validateInput,
  transactionController.createTransaction
);

router.get('/get-transaction', authenticateUser, transactionController.getUserTransactions);

router.get('/complete-transaction', authenticateUser, transactionController.getCompletedTransactions);

router.put("/cancel/:id", authenticateUser, transactionController.cancelTransaction); // Updated
router.post('/join-transaction', authenticateUser, transactionController.joinTransaction);

router.post('/accept-and-update', authenticateUser, [
  body('transactionId').notEmpty().withMessage('Transaction ID is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('price').notEmpty().isNumeric().withMessage('Price must be a number'),
], validateInput, transactionController.acceptAndUpdateTransaction);

router.post('/reject-transaction', authenticateUser, transactionController.rejectTransaction);

router.post('/update-payment-status', authenticateUser, transactionController.updatePaymentStatus);

router.post('/create-chatroom', authenticateUser, transactionController.createChatRoom);

router.get("/:id", authenticateUser, transactionController.getTransactionById);

router.post('/submit-waybill', authenticateUser, upload.single('image'), transactionController.submitWaybillDetails);

router.get('/waybill-details/:transactionId', authenticateUser, transactionController.getWaybillDetails);

router.get('/chatroom/:chatroomId', authenticateUser, transactionController.getTransactionByChatroomId);

router.post('/confirm', authenticateUser, transactionController.confirmTransaction);
router.get('/banks', authenticateUser, transactionController.getBanks);

router.get('/wallet/paystack-callback', authenticateUser, transactionController.handlePaystackCallback);

router.post('/fund-transaction', authenticateUser, async (req, res) => {
  const { transactionId, amount } = req.body;
  if (!transactionId || !amount) {
    return res.status(400).json({ message: "Transaction ID and amount are required" });
  }
  await transactionController.fundTransactionWithWallet(req, res);
});

router.put('/update-payment-details/:transactionId', authenticateUser, transactionController.updatePaymentDetails);

module.exports = router;