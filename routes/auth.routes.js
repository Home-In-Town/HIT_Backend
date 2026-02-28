const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

const { protect } = require('../middleware/auth');

/**
 * Public Routes
 */

// Step 1: Check if number is registered or new
router.post('/check-phone', authController.checkPhone);

// Step 2 (New User): Start Registration (Trigger OTP)
router.post('/register', authController.register);

// Step 2/3 (New User / Reset): Verify OTP and Log In
router.post('/verify-otp', authController.verifyOtp);

// Step 2 (Existing User): Log In with MPIN
router.post('/login', authController.login);

// Forgot MPIN
router.post('/forgot-mpin', authController.forgotMpin);

// Reset MPIN via OTP
router.post('/reset-mpin', authController.resetMpin);

/**
 * Authenticated Routes
 */

router.get('/me', protect, authController.getMe);

/**
 * Common Routes
 */

router.post('/logout', authController.logout);

module.exports = router;
