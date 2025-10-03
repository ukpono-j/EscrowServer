const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

/* ----------------------------------------------------
   NEW OTP FLOW
---------------------------------------------------- */
router.post('/register/request-otp', authController.requestRegistrationOTP);
router.post('/register/verify-otp',   authController.verifyRegistrationOTP);

/* ----------------------------------------------------
   LEGACY (still works – redirects to OTP flow)
---------------------------------------------------- */
router.post('/register', authController.register); // already aliases to requestRegistrationOTP

/* ----------------------------------------------------
   OTHER AUTH END-POINTS
---------------------------------------------------- */
router.post('/login',          authController.login);
router.post('/forgot-password',authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/refreshToken',   authController.refreshToken);

module.exports = router;