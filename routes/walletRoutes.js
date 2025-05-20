const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateUser = require('../middlewares/authenticateUser');
const paystackWebhookAuth = require('../utils/VerifyPaystackSignature');

router.get('/balance', authenticateUser, walletController.getWalletBalance);
router.post('/fund', authenticateUser, walletController.initiateFunding);
router.get('/funding-status/:reference', authenticateUser, walletController.checkFundingStatus);
router.post('/reconcile', authenticateUser, walletController.manualReconcileTransaction); // Updated to match controller
router.post('/verify-account', authenticateUser, walletController.verifyAccount);
router.post('/withdraw', authenticateUser, walletController.withdrawFunds);
router.get('/transactions', authenticateUser, walletController.getWalletTransactions);
router.post('/webhook/paystack', paystackWebhookAuth, walletController.verifyFunding);

module.exports = router;