const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// ═══════════════════════════════════════════════════════════
// ACTIVE ROUTES (Direct registration without OTP)
// ═══════════════════════════════════════════════════════════

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refreshToken', authController.refreshToken);

// ═══════════════════════════════════════════════════════════
// DISABLED ROUTES (Return 503 Service Unavailable)
// ═══════════════════════════════════════════════════════════

router.post('/register/request-otp', authController.requestRegistrationOTP);
router.post('/register/verify-otp', authController.verifyRegistrationOTP);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

module.exports = router;