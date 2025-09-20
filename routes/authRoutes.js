// authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Debug log to verify import
console.log('authController:', authController);

router.post('/login', authController.login);
router.post('/register', authController.register);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/refreshToken', authController.refreshToken);

module.exports = router;