const express = require('express');
const multer = require('multer');
const router = express.Router();
const groupChatController = require('../controllers/groupChatController');
const { protect, restrictTo } = require('../middleware/auth');

// Group attachments are kept in memory only long enough to stream them to R2.
// Authentication + membership checks run before the controller writes anything.
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// All group chat routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent', 'captain', 'employee'));

// ── Group Rooms ─────────────────────────────────────────
router.post('/rooms', groupChatController.createRoom);
router.get('/rooms', groupChatController.getRooms);
router.post('/rooms/:roomId/join', groupChatController.joinRoom);
// Join a property's group straight from an inventory card (card has a projectId,
// not a roomId). Declared before '/rooms/...' params to keep the paths distinct.
router.post('/projects/:projectId/join', groupChatController.joinProjectRoom);
router.post('/rooms/:roomId/leave', groupChatController.leaveRoom);
router.delete('/rooms/:roomId', groupChatController.deleteRoom);

// ── Group Messages / Attachments ─────────────────────────
router.post('/rooms/:roomId/attachments', attachmentUpload.single('file'), groupChatController.uploadAttachment);
// Clears the caller's unread badge for this room.
router.post('/rooms/:roomId/read', groupChatController.markRoomRead);
router.get('/rooms/:roomId/messages', groupChatController.getMessages);
router.post('/rooms/:roomId/messages', groupChatController.postMessage);
// Remove a message (own message, or any message in a group you own/admin).
// Media messages also get their R2 object deleted.
router.delete('/rooms/:roomId/messages/:messageId', groupChatController.deleteMessage);

// ── Deal Rooms (Interested flow) ────────────────────────
router.post('/interested', groupChatController.showInterest);
router.get('/deals', groupChatController.getDeals);
router.put('/deals/:dealId/status', groupChatController.updateDealStatus);

module.exports = router;
