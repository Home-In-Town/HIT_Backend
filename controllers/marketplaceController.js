const MarketplaceListing = require('../models/MarketplaceListing');
const MarketplaceAction = require('../models/MarketplaceAction');
const Notification = require('../models/Notification');

/**
 * POST /api/marketplace/listings
 * Create a new marketplace listing (selling/buying)
 */
exports.createListing = async (req, res) => {
  try {
    const { project, listingType, commissionPercentage, description, expectedValue, tags } = req.body;
    const listedBy = req.user._id;

    if (!project || !listingType || commissionPercentage === undefined) {
      return res.status(400).json({ error: 'project, listingType, and commissionPercentage are required' });
    }

    const listing = await MarketplaceListing.create({
      project,
      listedBy,
      listingType,
      commissionPercentage,
      description: description || '',
      expectedValue: expectedValue || 0,
      tags: tags || []
    });

    await listing.populate('project', 'projectName city location pricing');
    await listing.populate('listedBy', 'name companyName role');

    res.status(201).json({ listing });
  } catch (err) {
    console.error('createListing error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/marketplace/listings
 * Get all active listings (marketplace browse page)
 */
exports.getListings = async (req, res) => {
  try {
    const { listingType, search, page = 1, limit = 20 } = req.query;

    const filter = { status: 'Active' };
    if (listingType) filter.listingType = listingType;

    const listings = await MarketplaceListing.find(filter)
      .populate('project', 'projectName city location pricing media configuration')
      .populate('listedBy', 'name companyName role')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    const total = await MarketplaceListing.countDocuments(filter);

    res.status(200).json({ listings, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('getListings error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/marketplace/listings/my
 * Get listings created by current user
 */
exports.getMyListings = async (req, res) => {
  try {
    const listings = await MarketplaceListing.find({ listedBy: req.user._id })
      .populate('project', 'projectName city location pricing')
      .sort({ createdAt: -1 });

    res.status(200).json({ listings });
  } catch (err) {
    console.error('getMyListings error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/marketplace/listings/:id
 * Get a single listing with details
 */
exports.getListingById = async (req, res) => {
  try {
    const listing = await MarketplaceListing.findById(req.params.id)
      .populate('project', 'projectName city location pricing media configuration amenities cta')
      .populate('listedBy', 'name companyName role phone');

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Track view action (do not track own views)
    if (req.user._id.toString() !== listing.listedBy._id.toString()) {
      listing.viewsCount += 1;
      await listing.save();

      // Log view action
      await MarketplaceAction.create({
        listing: listing._id,
        actor: req.user._id,
        actionType: 'viewed'
      });
    }

    res.status(200).json({ listing });
  } catch (err) {
    console.error('getListingById error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/marketplace/listings/:id
 * Update a listing (only owner)
 */
exports.updateListing = async (req, res) => {
  try {
    const { status, commissionPercentage, description, expectedValue, tags } = req.body;

    const listing = await MarketplaceListing.findOne({
      _id: req.params.id,
      listedBy: req.user._id
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found or not authorized' });
    }

    if (status) listing.status = status;
    if (commissionPercentage !== undefined) listing.commissionPercentage = commissionPercentage;
    if (description !== undefined) listing.description = description;
    if (expectedValue !== undefined) listing.expectedValue = expectedValue;
    if (tags) listing.tags = tags;

    await listing.save();
    await listing.populate('project', 'projectName city');

    res.status(200).json({ listing });
  } catch (err) {
    console.error('updateListing error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/marketplace/listings/:id/action
 * Track an action on a listing (inquiry, share, claim, deal_closed)
 */
exports.trackAction = async (req, res) => {
  try {
    const { actionType, notes } = req.body;
    const actorId = req.user._id;

    const listing = await MarketplaceListing.findById(req.params.id)
      .populate('listedBy', 'name');

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Build commission data
    let commission = {
      percentage: listing.commissionPercentage,
      baseValue: listing.expectedValue,
      earnedAmount: 0,
      status: 'pending'
    };

    // Calculate earned amount for deal_closed
    if (actionType === 'deal_closed') {
      commission.earnedAmount = (listing.expectedValue * listing.commissionPercentage) / 100;
      commission.status = 'pending'; // Needs admin approval

      // Close the listing
      listing.status = 'Sold';
      await listing.save();
    }

    const action = await MarketplaceAction.create({
      listing: listing._id,
      actor: actorId,
      actionType,
      commission,
      notes: notes || ''
    });

    // Notify listing owner about actions (not for views)
    if (actionType !== 'viewed') {
      await Notification.create({
        recipient: listing.listedBy._id,
        type: 'marketplace_action',
        title: `New ${actionType} on your listing`,
        message: `${req.user.name} ${actionType} your project listing`,
        reference: { model: 'MarketplaceAction', id: action._id }
      });

      if (req.app.get('io')) {
        req.app.get('io').to(listing.listedBy._id.toString()).emit('notification', {
          type: 'marketplace_action',
          title: `New ${actionType} on your listing`,
          actionId: action._id
        });
      }
    }

    res.status(201).json({ action });
  } catch (err) {
    console.error('trackAction error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/marketplace/commissions
 * Get commission summary for the current user
 */
exports.getCommissions = async (req, res) => {
  try {
    const userId = req.user._id;

    const actions = await MarketplaceAction.find({
      actor: userId,
      actionType: { $in: ['claimed', 'deal_closed'] }
    })
      .populate('listing', 'project listingType commissionPercentage expectedValue status')
      .sort({ createdAt: -1 });

    // Aggregate stats
    const totalEarned = actions
      .filter(a => a.commission?.status === 'paid')
      .reduce((sum, a) => sum + (a.commission?.earnedAmount || 0), 0);

    const totalPending = actions
      .filter(a => a.commission?.status === 'pending')
      .reduce((sum, a) => sum + (a.commission?.earnedAmount || 0), 0);

    res.status(200).json({
      actions,
      totalEarned,
      totalPending,
      totalActions: actions.length
    });
  } catch (err) {
    console.error('getCommissions error:', err);
    res.status(500).json({ error: err.message });
  }
};
