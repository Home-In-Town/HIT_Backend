const express = require('express');
const router = express.Router();
const marketplaceController = require('../controllers/marketplaceController');
const { protect, restrictTo } = require('../middleware/auth');

// All marketplace routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent', 'captain'));

// Listings
router.post('/listings', marketplaceController.createListing);
router.get('/listings', marketplaceController.getListings);
router.get('/listings/my', marketplaceController.getMyListings);
router.get('/listings/:id', marketplaceController.getListingById);
router.put('/listings/:id', marketplaceController.updateListing);

// Actions & Tracking
router.post('/listings/:id/action', marketplaceController.trackAction);

// Commissions
router.get('/commissions', marketplaceController.getCommissions);

// Admin only routes
router.get('/admin/actions', restrictTo('admin'), marketplaceController.getAllActions);
router.patch('/admin/actions/:id/status', restrictTo('admin'), marketplaceController.updateActionStatus);

module.exports = router;
