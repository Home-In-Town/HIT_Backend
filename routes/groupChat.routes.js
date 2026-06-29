const express = require('express');
const router = express.Router();
const groupChatController = require('../controllers/groupChatController');
const { protect, restrictTo } = require('../middleware/auth');

// All group chat routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent'));

// ── Group Rooms ─────────────────────────────────────────
router.post('/rooms', groupChatController.createRoom);
router.get('/rooms', groupChatController.getRooms);
router.post('/rooms/:roomId/join', groupChatController.joinRoom);
router.post('/rooms/:roomId/leave', groupChatController.leaveRoom);

// ── Group Messages ──────────────────────────────────────
router.get('/rooms/:roomId/messages', groupChatController.getMessages);
router.post('/rooms/:roomId/messages', groupChatController.postMessage);

// ── Deal Rooms (Interested flow) ────────────────────────
router.post('/interested', groupChatController.showInterest);
router.get('/deals', groupChatController.getDeals);
router.put('/deals/:dealId/status', groupChatController.updateDealStatus);

module.exports = router;
