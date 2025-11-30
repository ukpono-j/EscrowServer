const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const authorizeAdmin = require('../middlewares/authorizeAdmin');

router.post('/login', adminController.adminLogin);
router.get('/dashboard-stats', authorizeAdmin, adminController.getDashboardStats);
router.get('/users', authorizeAdmin, adminController.getAllUsers);
router.get('/transactions', authorizeAdmin, adminController.getAllTransactions);
router.get('/disputes', authorizeAdmin, adminController.getAllDisputes);
router.get('/kyc-pending', authorizeAdmin, adminController.getPendingKYC);
router.get('/withdrawals', authorizeAdmin, adminController.getAllWithdrawals);
router.post('/withdrawals/:id/paid', authorizeAdmin, adminController.markWithdrawalAsPaid);
router.post('/withdrawals/:id/reject', authorizeAdmin, adminController.rejectWithdrawal);

router.get('/customer/:email', authorizeAdmin, adminController.getCustomerFinancialSummary);

module.exports = router;