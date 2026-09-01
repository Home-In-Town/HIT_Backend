const User = require('../models/User');

// Shape a captain for the frontend
const shapeCaptain = (c) => ({
  id: c._id.toString(),
  name: c.name,
  companyName: c.companyName || '',
  phone: c.phone,
  businessCity: c.businessCity || '',
});

const idStr = (v) => (v && v._id ? v._id.toString() : v ? v.toString() : null);

/**
 * GET /api/captain-team/me
 * Returns the caller's partnership state: confirmed partners, incoming + outgoing requests.
 */
exports.getMyTeam = async (req, res) => {
  try {
    const me = await User.findById(req.user._id)
      .populate('partnerCaptains', 'name companyName phone businessCity')
      .populate('partnerRequestsIncoming', 'name companyName phone businessCity')
      .populate('partnerRequestsOutgoing', 'name companyName phone businessCity')
      .lean();

    return res.json({
      partners: (me.partnerCaptains || []).map(shapeCaptain),
      incoming: (me.partnerRequestsIncoming || []).map(shapeCaptain),
      outgoing: (me.partnerRequestsOutgoing || []).map(shapeCaptain),
    });
  } catch (err) {
    console.error('getMyTeam error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/captain-team/captains?search=
 * Lists other captains the caller can team up with, annotated with relationship status.
 */
exports.listCaptains = async (req, res) => {
  try {
    const { search } = req.query;
    const query = { role: 'captain', _id: { $ne: req.user._id }, isActive: true };
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ name: rx }, { companyName: rx }, { phone: rx }, { businessCity: rx }];
    }

    const me = await User.findById(req.user._id)
      .select('partnerCaptains partnerRequestsIncoming partnerRequestsOutgoing')
      .lean();
    const partners = new Set((me.partnerCaptains || []).map(idStr));
    const incoming = new Set((me.partnerRequestsIncoming || []).map(idStr));
    const outgoing = new Set((me.partnerRequestsOutgoing || []).map(idStr));

    const captains = await User.find(query)
      .select('name companyName phone businessCity')
      .sort({ name: 1 })
      .limit(50)
      .lean();

    return res.json({
      captains: captains.map((c) => {
        const id = c._id.toString();
        let status = 'none';
        if (partners.has(id)) status = 'partner';
        else if (incoming.has(id)) status = 'incoming';   // they invited me
        else if (outgoing.has(id)) status = 'outgoing';   // I invited them
        return { ...shapeCaptain(c), status };
      }),
    });
  } catch (err) {
    console.error('listCaptains error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/captain-team/request  { captainId }
 * Send a team-up request to another captain.
 * If the other captain already invited me, this auto-accepts (mutual).
 */
exports.sendRequest = async (req, res) => {
  try {
    const { captainId } = req.body;
    if (!captainId) return res.status(400).json({ error: 'captainId is required' });
    if (captainId === req.user._id.toString()) return res.status(400).json({ error: 'You cannot team up with yourself' });

    const target = await User.findById(captainId).select('role');
    if (!target || target.role !== 'captain') return res.status(404).json({ error: 'Captain not found' });

    const me = await User.findById(req.user._id).select('partnerCaptains partnerRequestsIncoming partnerRequestsOutgoing');

    if (me.partnerCaptains.some((p) => idStr(p) === captainId)) {
      return res.status(400).json({ error: 'Already teamed up with this captain' });
    }

    // If they already sent ME a request, accept it now (mutual link)
    if (me.partnerRequestsIncoming.some((p) => idStr(p) === captainId)) {
      await linkPartners(req.user._id.toString(), captainId);
      return res.json({ status: 'partner', message: 'You are now teamed up.' });
    }

    if (me.partnerRequestsOutgoing.some((p) => idStr(p) === captainId)) {
      return res.status(400).json({ error: 'Request already sent' });
    }

    // Record outgoing on me, incoming on them
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { partnerRequestsOutgoing: captainId } });
    await User.findByIdAndUpdate(captainId, { $addToSet: { partnerRequestsIncoming: req.user._id } });

    return res.json({ status: 'outgoing', message: 'Team-up request sent.' });
  } catch (err) {
    console.error('sendRequest error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/captain-team/accept  { captainId }
 * Accept an incoming team-up request → mutual partnership.
 */
exports.acceptRequest = async (req, res) => {
  try {
    const { captainId } = req.body;
    if (!captainId) return res.status(400).json({ error: 'captainId is required' });

    const me = await User.findById(req.user._id).select('partnerRequestsIncoming');
    if (!me.partnerRequestsIncoming.some((p) => idStr(p) === captainId)) {
      return res.status(400).json({ error: 'No pending request from this captain' });
    }

    await linkPartners(req.user._id.toString(), captainId);
    return res.json({ status: 'partner', message: 'You are now teamed up.' });
  } catch (err) {
    console.error('acceptRequest error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/captain-team/decline  { captainId }
 * Decline an incoming request (or cancel one I sent).
 */
exports.declineRequest = async (req, res) => {
  try {
    const { captainId } = req.body;
    if (!captainId) return res.status(400).json({ error: 'captainId is required' });

    // Remove the request from both directions regardless of who initiated it
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { partnerRequestsIncoming: captainId, partnerRequestsOutgoing: captainId },
    });
    await User.findByIdAndUpdate(captainId, {
      $pull: { partnerRequestsIncoming: req.user._id, partnerRequestsOutgoing: req.user._id },
    });

    return res.json({ status: 'none', message: 'Request removed.' });
  } catch (err) {
    console.error('declineRequest error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/captain-team/remove  { captainId }
 * Remove an existing partnership (both sides).
 */
exports.removePartner = async (req, res) => {
  try {
    const { captainId } = req.body;
    if (!captainId) return res.status(400).json({ error: 'captainId is required' });

    await User.findByIdAndUpdate(req.user._id, { $pull: { partnerCaptains: captainId } });
    await User.findByIdAndUpdate(captainId, { $pull: { partnerCaptains: req.user._id } });

    return res.json({ status: 'none', message: 'Partnership removed.' });
  } catch (err) {
    console.error('removePartner error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ──

// Create a symmetric partnership and clear any pending requests between the two.
async function linkPartners(aId, bId) {
  await User.findByIdAndUpdate(aId, {
    $addToSet: { partnerCaptains: bId },
    $pull: { partnerRequestsIncoming: bId, partnerRequestsOutgoing: bId },
  });
  await User.findByIdAndUpdate(bId, {
    $addToSet: { partnerCaptains: aId },
    $pull: { partnerRequestsIncoming: aId, partnerRequestsOutgoing: aId },
  });
}

module.exports = exports;
