const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

const { protect } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { validate, authValidationSchemas } = require('../middleware/authValidation');

/**
 * Public Routes
 */

// Register with validation
router.post(
  '/register',
  authLimiter,
  validate(authValidationSchemas.register),
  authController.register
);

// Verify OTP with validation
router.post(
  '/verify-otp',
  authLimiter,
  validate(authValidationSchemas.verifyOtp),
  authController.verifyOtp
);

// Login with validation
router.post(
  '/login',
  authLimiter,
  validate(authValidationSchemas.login),
  authController.login
);

// Forgot MPIN with validation
router.post(
  '/forgot-mpin',
  authLimiter,
  validate(authValidationSchemas.forgotMpin),
  authController.forgotMpin
);

// Reset MPIN with validation
router.post(
  '/reset-mpin',
  authLimiter,
  validate(authValidationSchemas.resetMpin),
  authController.resetMpin
);

/**
 * Authenticated Routes
 */

router.get('/me', protect, authController.getMe);
router.get('/session', authController.getSession);

/**
 * Common Routes
 */

router.post('/logout', authLimiter, authController.logout);


module.exports = router;
