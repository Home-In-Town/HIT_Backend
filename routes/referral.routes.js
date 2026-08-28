const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referralController');
const { protect } = require('../middleware/auth');

// All referral routes require authentication
router.use(protect);

// Current user's referral code, link, history and unlock status
router.get('/me', referralController.getMyReferrals);

module.exports = router;
