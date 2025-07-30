const express = require('express');
const router = express.Router();
const User = require('../modules/Users');
const bcrypt = require('bcrypt'); // Add bcrypt import
const adminController = require('../controllers/adminController');
const authorizeAdmin = require('../middlewares/authorizeAdmin');

router.get('/dashboard-stats', authorizeAdmin, adminController.getDashboardStats);
router.get('/users', authorizeAdmin, adminController.getAllUsers);
router.get('/transactions', authorizeAdmin, adminController.getAllTransactions);
router.get('/kyc-pending', authorizeAdmin, adminController.getPendingKYC);


module.exports = router;