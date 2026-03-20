const express = require('express');
const router = express.Router();
const marketplaceController = require('../controllers/marketplaceController');
const { protect, restrictTo } = require('../middleware/auth');

// All marketplace routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent'));

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

module.exports = router;
