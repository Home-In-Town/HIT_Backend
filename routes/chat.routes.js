const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { protect, restrictTo } = require('../middleware/auth');

// All chat routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent'));

// Contacts list
router.get('/contacts', chatController.getContacts);

// Pre-chat qualification & session creation
router.post('/qualify', chatController.qualifyAndConnect);

// Get all chat sessions
router.get('/sessions', chatController.getSessions);

// Get messages for a session
router.get('/sessions/:sessionId/messages', chatController.getMessages);

module.exports = router;
