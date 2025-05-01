const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateUser = require('../middlewares/authenticateUser');

// Routes that require authentication
router.get('/balance', authenticateUser, walletController.getWalletBalance);
router.get('/transactions', authenticateUser, walletController.getWalletTransactions);
router.post('/fund', authenticateUser, walletController.initiateFunding);
router.get('/verify-funding/:reference', authenticateUser, walletController.checkFundingStatus);
router.post('/pay', authenticateUser, walletController.useWalletForPayment);

// Webhook route - no authentication required as it's called by PaymentPoint
router.post('/verify-funding', walletController.verifyFunding);

module.exports = router;