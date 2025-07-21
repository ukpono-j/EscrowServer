const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateUser = require('../middlewares/authenticateUser');
const paystackWebhookAuth = require('../utils/VerifyPaystackSignature');


router.get('/balance', authenticateUser, walletController.getWalletBalance);
router.post('/fund', authenticateUser, walletController.initiateFunding);
router.get('/funding-status/:reference', authenticateUser, walletController.checkFundingStatus);
router.post('/reconcile', authenticateUser, walletController.manualReconcileTransaction);
router.post('/verify-account', authenticateUser, walletController.verifyAccount);
router.post('/withdraw', authenticateUser, walletController.withdrawFunds);
router.get('/transactions', authenticateUser, walletController.getWalletTransactions);
router.get('/paystack/banks', authenticateUser, walletController.getPaystackBanks);
router.get('/check-paystack-balance', authenticateUser, walletController.checkPaystackBalance); // Added route
router.post('/check-funding-readiness', authenticateUser, walletController.checkFundingReadiness);
router.post('/webhook/paystack', paystackWebhookAuth, walletController.verifyFunding, walletController.verifyWithdrawal);


module.exports = router;