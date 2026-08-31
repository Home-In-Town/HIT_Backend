/**
 * leadChat.routes
 *
 * AI Lead Matching — conversational slot-filling endpoints.
 * All routes require authentication and operate only on the authenticated
 * user's own AI Assistant thread.
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const leadChatController = require('../controllers/leadChatController');

router.use(protect);

router.post('/open', leadChatController.openAssistantThread);
router.post('/answer', leadChatController.submitAnswer);
router.post('/edit', leadChatController.editSlot);
router.post('/confirm', leadChatController.confirmLead);
router.post('/new', leadChatController.startNewLead);

module.exports = router;
