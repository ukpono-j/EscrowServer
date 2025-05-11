const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateUser = require('../middlewares/authenticateUser');

// Routes that require authentication
router.get('/balance', authenticateUser, walletController.getWalletBalance);
router.post('/fund', authenticateUser, walletController.initiateFunding);
router.get('/verify-funding/:reference', authenticateUser, walletController.checkFundingStatus);

// Webhook route - no authentication required as it's called by PaymentPoint
router.post('/verify-funding', walletController.verifyFunding);

router.post('/reconcile', authenticateUser, walletController.reconcileTransactions);
router.get('/transactions', authenticateUser, walletController.getWalletTransactions);

// New routes for account verification and withdrawal
router.post('/verify-account', authenticateUser, walletController.verifyAccount);
router.post('/withdraw', authenticateUser, walletController.withdrawFunds);

module.exports = router;