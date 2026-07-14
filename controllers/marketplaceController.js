const MarketplaceListing = require('../models/MarketplaceListing');
const MarketplaceAction = require('../models/MarketplaceAction');
const Notification = require('../models/Notification');

/**
 * POST /api/marketplace/listings
 * Create a new marketplace listing (selling/buying)
 */
exports.createListing = async (req, res) => {
  try {
    const { project, listingType, commissionType, commissionValue, description, expectedValue, tags } = req.body;
    const listedBy = req.user._id;

    if (!listingType || commissionValue === undefined) {
      return res.status(400).json({ error: 'listingType and commissionValue are required' });
    }
    if (listingType === 'selling' && !project) {
        return res.status(400).json({ error: 'project is required for selling' });
    }

    const listing = await MarketplaceListing.create({
      project,
      listedBy,
      listingType,
      commissionType: commissionType || 'percentage',
      commissionValue,
      description: description || '',
      expectedValue: expectedValue || 0,
      tags: tags || []
    });

    await listing.populate({ path: 'project', select: 'projectName city location pricing', populate: { path: 'owner', select: 'name role companyName phone' } });
    await listing.populate('listedBy', 'name companyName role phone');

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
      .populate({ path: 'project', select: 'projectName city location pricing media configuration slug owner', populate: { path: 'owner', select: 'name role companyName phone' } })
      .populate('listedBy', 'name companyName role phone')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    const total = await MarketplaceListing.countDocuments(filter);

    // Captain: 1) own listings, 2) listings in captain's city/state, 3) everything else
    if (req.user && req.user.role === 'captain') {
      const captainId = req.user._id.toString();
      console.log('[Captain Sort] captainId:', captainId);
      console.log('[Captain Sort] listings count:', listings.length);
      listings.forEach((l, i) => {
        const listedById = l.listedBy?._id?.toString() || l.listedBy?.toString();
        const projectOwnerId = l.project?.owner?._id?.toString() || l.project?.owner?.toString();
        console.log(`[Captain Sort] listing[${i}] "${l.project?.projectName || 'buying'}" | listedBy: ${listedById} | projectOwner: ${projectOwnerId} | listingId: ${l._id}`);
      });

      // Normalise location strings for loose matching
      const captainCity  = (req.user.businessCity  || '').toLowerCase().trim();
      const captainState = (req.user.businessState || '').toLowerCase().trim();

      const tier1 = []; // captain's own
      const tier2 = []; // nearby (same city or state)
      const tier3 = []; // everything else

      for (const listing of listings) {
        const listedById = listing.listedBy?._id?.toString() || listing.listedBy?.toString();

        const projectOwnerId = listing.project?.owner?._id?.toString() || listing.project?.owner?.toString();
        if (listedById === captainId || projectOwnerId === captainId) {
          tier1.push(listing);
          continue;
        }

        // Project city comes from the populated project field
        const projectCity  = (listing.project?.city  || '').toLowerCase().trim();
        const projectLocation = (listing.project?.location || '').toLowerCase().trim();

        const cityMatch  = captainCity  && (projectCity.includes(captainCity)  || captainCity.includes(projectCity));
        const stateMatch = captainState && projectLocation.includes(captainState);

        if (cityMatch || stateMatch) {
          tier2.push(listing);
        } else {
          tier3.push(listing);
        }
      }

      const sortedListings = [...tier1, ...tier2, ...tier3];
      return res.status(200).json({ listings: sortedListings, total, page: parseInt(page), limit: parseInt(limit) });
    }

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
      .populate({ path: 'project', select: 'projectName city location pricing media configuration slug', populate: { path: 'owner', select: 'name role companyName' } })
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
      .populate({ path: 'project', select: 'projectName city location pricing media configuration amenities cta slug', populate: { path: 'owner', select: 'name role companyName' } })
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
    const { status, commissionType, commissionValue, description, expectedValue, tags } = req.body;

    const listing = await MarketplaceListing.findOne({
      _id: req.params.id,
      listedBy: req.user._id
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found or not authorized' });
    }

    if (status) listing.status = status;
    if (commissionType) listing.commissionType = commissionType;
    if (commissionValue !== undefined) listing.commissionValue = commissionValue;
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
      type: listing.commissionType,
      value: listing.commissionValue,
      baseValue: listing.expectedValue,
      earnedAmount: 0,
      status: 'pending'
    };

    // Calculate earned amount for deal_closed
    if (actionType === 'deal_closed') {
      if (listing.commissionType === 'percentage') {
        commission.earnedAmount = (listing.expectedValue * listing.commissionValue) / 100;
      } else {
        commission.earnedAmount = listing.commissionValue;
      }
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

/**
 * GET /api/marketplace/admin/actions
 * Admin only: Get all marketplace actions (claims, inquiries, deals) across all users
 */
exports.getAllActions = async (req, res) => {
  try {
    const actions = await MarketplaceAction.find({
      actionType: { $in: ['claimed', 'deal_closed', 'inquired'] }
    })
      .populate({
        path: 'listing',
        populate: {
          path: 'project',
          select: 'projectName city location',
          populate: { path: 'owner', select: 'name role companyName' }
        }
      })
      .populate('actor', 'name email role companyName phone')
      .sort({ createdAt: -1 });

    res.status(200).json({ actions });
  } catch (err) {
    console.error('getAllActions error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/marketplace/admin/actions/:id/status
 * Admin only: Approve/Reject/Mark Paid for a commission/referral
 */
exports.updateActionStatus = async (req, res) => {
  try {
    const { status } = req.body; // 'approved', 'paid', 'rejected', 'pending'
    
    if (!['approved', 'paid', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const action = await MarketplaceAction.findById(req.params.id);
    if (!action) return res.status(404).json({ error: 'Action not found' });

    if (action.commission) {
      action.commission.status = status;
      await action.save();
    }

    res.status(200).json({ action });
  } catch (err) {
    console.error('updateActionStatus error:', err);
    res.status(500).json({ error: err.message });
  }
};
