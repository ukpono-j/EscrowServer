const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authenticateUser = require('../middlewares/authenticateUser');
const paystackWebhookAuth = require('../utils/VerifyPaystackSignature');

// Restrict to API key or superadmin role
const restrictToApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_CREATE_KEY) {
    return res.status(403).json({ success: false, error: 'Invalid API key' });
  }
  next();
};


router.get('/balance', authenticateUser, walletController.getWalletBalance);
router.post('/fund', authenticateUser, walletController.initiateFunding);
router.get('/funding-status/:reference', authenticateUser, walletController.checkFundingStatus);
router.post('/reconcile', authenticateUser, walletController.manualReconcileTransaction);
router.post('/verify-account', authenticateUser, walletController.verifyAccount);
router.post('/withdraw', authenticateUser, walletController.withdrawFunds);
router.get('/transactions', authenticateUser, walletController.getWalletTransactions);
router.get('/paystack/banks', authenticateUser, walletController.getPaystackBanks);
router.post('/sync', authenticateUser, walletController.syncWalletBalance);
router.get('/check-paystack-balance', authenticateUser, walletController.checkPaystackBalance); // Added route
router.post('/webhook/paystack', paystackWebhookAuth, walletController.verifyFunding, walletController.verifyWithdrawal);


module.exports = router;