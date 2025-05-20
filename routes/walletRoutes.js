const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateUser = require('../middlewares/authenticateUser');

router.get('/balance', authenticateUser, walletController.getWalletBalance);
router.post('/fund', authenticateUser, walletController.initiateFunding);
router.get('/funding-status/:reference', authenticateUser, walletController.checkFundingStatus);
router.post('/reconcile', authenticateUser, walletController.reconcileTransactions);
router.post('/verify-account', authenticateUser, walletController.verifyAccount);
router.post('/withdraw', authenticateUser, walletController.withdrawFunds);
router.get('/transactions', authenticateUser, walletController.getWalletTransactions);

// Dedicated Paystack webhook route (unauthenticated)
router.post('/webhook/paystack', walletController.verifyFunding);

module.exports = router;