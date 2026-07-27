const express = require('express');
const { protect, restrictTo } = require('../middleware/auth');
const ShareController = require('../controllers/shareController');
const GalleryController = require('../controllers/galleryController');

const router = express.Router();

/**
 * Share Token Routes (Authenticated)
 * Base path: /api/share
 */

// Generate a share token for a project (captain, agent, builder)
router.post(
  '/generate',
  protect,
  restrictTo('captain', 'agent', 'builder', 'admin'),
  (req, res) => ShareController.generateToken(req, res)
);

// Download project gallery as ZIP with contact details
router.get(
  '/gallery/:projectId',
  protect,
  (req, res) => GalleryController.downloadGallery(req, res)
);

// Get authenticated user's contact info (for PDF embedding on frontend)
router.get(
  '/my-contact',
  protect,
  (req, res) => ShareController.getMyContactForPdf(req, res)
);

// Get all share tokens created by the authenticated user (analytics)
router.get(
  '/my-shares',
  protect,
  (req, res) => ShareController.getMyShares(req, res)
);

// Deactivate a share token
router.delete(
  '/:token',
  protect,
  (req, res) => ShareController.deactivateToken(req, res)
);

module.exports = router;
