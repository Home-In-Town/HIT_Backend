const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const leadCaptureService = require('../services/LeadCaptureService');
const ExtractedLead = require('../models/ExtractedLead');

/**
 * Lead Matching Routes
 * 
 * Debug/test endpoints + admin dashboard endpoints for the NLP lead matching system.
 * All routes require authentication.
 */

// ═══════════════════════════════════════════════════════════
// DEBUG / TEST ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/lead-matching/extract
 * Test NLP extraction only (no DB write, no matching)
 * Useful for testing what params get extracted from a message.
 * 
 * Body: { text: "I need 2bhk flat near Manish Nagar 60L budget" }
 */
router.post('/extract', protect, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const result = leadCaptureService.extractOnly(text);
    if (!result) {
      return res.json({
        detected: false,
        message: 'No requirement intent detected in this text'
      });
    }

    return res.json({
      detected: true,
      ...result
    });
  } catch (err) {
    console.error('extract error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/lead-matching/test-match
 * Test full extraction + matching (no DB write, no notifications)
 * Returns extraction results and matching projects.
 * 
 * Body: { text: "looking for 2bhk flat near Manish Nagar 60 lakh budget" }
 */
router.post('/test-match', protect, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const result = await leadCaptureService.extractAndMatch(text, req.user._id.toString());

    if (!result.extraction) {
      return res.json({
        detected: false,
        message: 'No requirement intent detected'
      });
    }

    return res.json({
      detected: true,
      extraction: result.extraction,
      matches: result.matches.map(m => ({
        project: {
          _id: m.project._id,
          projectName: m.project.projectName,
          city: m.project.city,
          location: m.project.location,
          pricing: m.project.pricing,
          configuration: m.project.configuration,
          owner: m.project.owner
        },
        score: m.score,
        confidence: m.confidence,
        matchedOn: m.matchedOn,
        breakdown: m.breakdown
      })),
      matchCount: result.matches.length
    });
  } catch (err) {
    console.error('test-match error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// EXTRACTED LEADS — ADMIN / CAPTAIN DASHBOARD
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/lead-matching/leads
 * Get all extracted leads (admin sees all, agents/captains see their own)
 * 
 * Query params: page, limit, status, minConfidence, source
 */
router.get('/leads', protect, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, minConfidence, source } = req.query;
    const userId = req.user._id;
    const userRole = req.user.role;

    const filter = {};

    // Role-based access
    if (userRole === 'admin') {
      // Admin sees everything
    } else if (userRole === 'captain') {
      // Captain sees their own + their team's leads
      // (team = users with employerId pointing to this captain)
      const User = require('../models/User');
      const teamMembers = await User.find({ employerId: userId }).select('_id');
      const teamIds = [userId, ...teamMembers.map(m => m._id)];
      filter.extractedBy = { $in: teamIds };
    } else {
      // Agent sees only their own
      filter.extractedBy = userId;
    }

    // Optional filters
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (minConfidence) filter.extractionConfidence = { $gte: parseFloat(minConfidence) };

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [leads, total] = await Promise.all([
      ExtractedLead.find(filter)
        .populate('extractedBy', 'name role companyName')
        .populate('matches.project', 'projectName city location pricing configuration slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      ExtractedLead.countDocuments(filter)
    ]);

    return res.json({
      leads,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('getLeads error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/lead-matching/leads/:leadId
 * Get a single extracted lead with full details
 */
router.get('/leads/:leadId', protect, async (req, res) => {
  try {
    const lead = await ExtractedLead.findById(req.params.leadId)
      .populate('extractedBy', 'name role companyName phone')
      .populate('matches.project', 'projectName city location pricing configuration owner media slug')
      .populate('sourceRoom')
      .lean();

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Access check
    const userRole = req.user.role;
    if (userRole !== 'admin') {
      if (lead.extractedBy._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Not authorized to view this lead' });
      }
    }

    return res.json({ lead });
  } catch (err) {
    console.error('getLead error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/lead-matching/leads/:leadId/status
 * Update lead status (confirm, reject, convert)
 * 
 * Body: { status: 'confirmed' | 'rejected' | 'converted', convertedTo?: dealRoomId }
 */
router.patch('/leads/:leadId/status', protect, async (req, res) => {
  try {
    const { status, convertedTo } = req.body;
    const validStatuses = ['confirmed', 'rejected', 'converted'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const update = { status };
    if (status === 'converted' && convertedTo) {
      update.convertedTo = convertedTo;
    }

    const lead = await ExtractedLead.findByIdAndUpdate(
      req.params.leadId,
      { $set: update },
      { new: true }
    ).populate('extractedBy', 'name role');

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json({ lead, message: `Lead status updated to ${status}` });
  } catch (err) {
    console.error('updateLeadStatus error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/lead-matching/stats
 * Get lead matching statistics (admin only)
 */
router.get('/stats', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const [total, byStatus, bySource, avgConfidence, withMatches] = await Promise.all([
      ExtractedLead.countDocuments(),
      ExtractedLead.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      ExtractedLead.aggregate([
        { $group: { _id: '$source', count: { $sum: 1 } } }
      ]),
      ExtractedLead.aggregate([
        { $group: { _id: null, avg: { $avg: '$extractionConfidence' } } }
      ]),
      ExtractedLead.countDocuments({ matchCount: { $gt: 0 } })
    ]);

    return res.json({
      total,
      withMatches,
      matchRate: total > 0 ? ((withMatches / total) * 100).toFixed(1) + '%' : '0%',
      avgConfidence: avgConfidence[0]?.avg?.toFixed(2) || 0,
      byStatus: Object.fromEntries(byStatus.map(s => [s._id, s.count])),
      bySource: Object.fromEntries(bySource.map(s => [s._id, s.count]))
    });
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
