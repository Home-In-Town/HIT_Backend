const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

const { protect } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

/**
 * Public Routes
 */

// Registration (Trigger OTP)
router.post('/register', authLimiter, authController.register);

// Step 2/3 (New User / Reset): Verify OTP and Log In
router.post('/verify-otp', authLimiter, authController.verifyOtp);

// Step 2 (Existing User): Log In with MPIN
router.post('/login', authLimiter, authController.login);

// Forgot MPIN
router.post('/forgot-mpin', authController.forgotMpin);

// Reset MPIN via OTP
router.post('/reset-mpin', authLimiter, authController.resetMpin);

/**
 * Authenticated Routes
 */

router.get('/me', protect, authController.getMe);

/**
 * Common Routes
 */

router.post('/logout', authController.logout);

module.exports = router;
