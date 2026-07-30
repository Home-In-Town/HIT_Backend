'use strict';

const LeadJourney = require('../models/LeadJourney');
const leadGenService = require('../services/LeadGenService');
const Logger = require('../utils/logger');

const logger = new Logger('LeadJourney');

// Valid stage transitions (can only move forward or to 'lost')
const STAGE_ORDER = [
    'lead_captured',
    'contacted',
    'qualified',
    'site_visit_scheduled',
    'site_visit_done',
    'offer_made',
    'negotiation',
    'deal_closed',
];

const STAGE_LABELS = {
    lead_captured: 'Lead Captured',
    contacted: 'First Contact Made',
    qualified: 'Qualified (Interested)',
    site_visit_scheduled: 'Site Visit Scheduled',
    site_visit_done: 'Site Visit Completed',
    offer_made: 'Offer Presented',
    negotiation: 'In Negotiation',
    deal_closed: 'Deal Closed',
    lost: 'Lost / Not Interested',
};

/**
 * GET /api/crm-bridge/journey/:leadId
 * Returns the full journey timeline for a lead.
 * Auto-creates journey if it doesn't exist.
 */
exports.getJourney = async (req, res) => {
    try {
        const { leadId } = req.params;
        const user = await require('../models/User').findById(req.user._id)
            .select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user?.oneEmployeeLinked || !user?.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const ownerId = user.oneEmployeeOwnerId;

        let journey = await LeadJourney.findOne({ leadId, ownerId }).lean();

        // Auto-create journey with first stage if it doesn't exist
        if (!journey) {
            // Fetch lead data from OneEmployee to populate snapshot
            let leadSnapshot = {};
            try {
                const leadData = await leadGenService.getLeadById(leadId, ownerId);
                leadSnapshot = {
                    firstName: leadData.first_name,
                    lastName: leadData.last_name,
                    phone: leadData.phone_number,
                    email: leadData.email,
                    source: leadData.source,
                    score: leadData.score,
                    status: leadData.status,
                    projectName: leadData.hitProjectName || leadData.metadata?.campaignName || '',
                    campaignName: leadData.metadata?.campaignName || '',
                };
            } catch { /* non-fatal — create journey anyway */ }

            journey = await LeadJourney.create({
                leadId,
                ownerId,
                currentStage: 'lead_captured',
                leadSnapshot,
                timeline: [{
                    stage: 'lead_captured',
                    timestamp: new Date(),
                    notes: 'Lead entered the system',
                    metadata: { channel: leadSnapshot.source || 'unknown' },
                    movedBy: { userId: 'system', name: 'System', role: 'automation' },
                }],
            });
            journey = journey.toObject();
        }

        // Add labels for frontend display
        const enrichedTimeline = journey.timeline.map(entry => ({
            ...entry,
            stageLabel: STAGE_LABELS[entry.stage] || entry.stage,
        }));

        return res.json({
            ...journey,
            timeline: enrichedTimeline,
            currentStageLabel: STAGE_LABELS[journey.currentStage] || journey.currentStage,
            stageLabels: STAGE_LABELS,
            stageOrder: STAGE_ORDER,
        });
    } catch (err) {
        logger.error('getJourney error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/journey/:leadId/advance
 * Moves the lead to the next stage or a specific stage.
 * Body: { stage, notes, metadata }
 */
exports.advanceStage = async (req, res) => {
    try {
        const { leadId } = req.params;
        const { stage, notes, metadata } = req.body;
        const User = require('../models/User');
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId name role');

        if (!user?.oneEmployeeLinked || !user?.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const ownerId = user.oneEmployeeOwnerId;

        if (!stage) {
            return res.status(400).json({ error: 'stage is required' });
        }

        if (!STAGE_ORDER.includes(stage) && stage !== 'lost') {
            return res.status(400).json({ error: `Invalid stage. Must be one of: ${[...STAGE_ORDER, 'lost'].join(', ')}` });
        }

        let journey = await LeadJourney.findOne({ leadId, ownerId });

        // Auto-create if doesn't exist
        if (!journey) {
            journey = new LeadJourney({
                leadId,
                ownerId,
                currentStage: 'lead_captured',
                timeline: [{
                    stage: 'lead_captured',
                    timestamp: new Date(),
                    notes: 'Lead entered the system',
                    movedBy: { userId: 'system', name: 'System', role: 'automation' },
                }],
            });
        }

        // Validate stage transition (can't go backwards, except to 'lost')
        if (stage !== 'lost') {
            const currentIdx = STAGE_ORDER.indexOf(journey.currentStage);
            const targetIdx = STAGE_ORDER.indexOf(stage);
            if (targetIdx <= currentIdx && journey.currentStage !== 'lost') {
                return res.status(400).json({
                    error: `Cannot move backwards. Current stage: "${STAGE_LABELS[journey.currentStage]}". Target: "${STAGE_LABELS[stage]}".`,
                });
            }
        }

        // Add new timeline entry
        const timelineEntry = {
            stage,
            timestamp: new Date(),
            notes: notes || '',
            metadata: metadata || {},
            movedBy: {
                userId: req.user._id.toString(),
                name: user.name || 'User',
                role: user.role || 'builder',
            },
        };

        journey.timeline.push(timelineEntry);
        journey.currentStage = stage;

        // If deal closed, mark as converted
        if (stage === 'deal_closed') {
            journey.isConverted = true;
            journey.convertedAt = new Date();
            if (metadata?.dealAmount) {
                journey.dealValue = metadata.dealAmount;
            }
        }

        // If lost, update property interest reason
        if (stage === 'lost' && metadata?.lostReason) {
            journey.propertyInterest = journey.propertyInterest || {};
        }

        await journey.save();

        logger.info('Journey advanced', { leadId, stage, by: user.name });

        return res.json({
            success: true,
            currentStage: stage,
            currentStageLabel: STAGE_LABELS[stage],
            timeline: journey.timeline.map(e => ({ ...e.toObject(), stageLabel: STAGE_LABELS[e.stage] })),
        });
    } catch (err) {
        logger.error('advanceStage error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * PUT /api/crm-bridge/journey/:leadId/property-interest
 * Updates the property interest details for a lead.
 * Body: { projectId, projectName, bhkPreference, budgetRange, preferredLocation, timeline, loanRequired }
 */
exports.updatePropertyInterest = async (req, res) => {
    try {
        const { leadId } = req.params;
        const User = require('../models/User');
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user?.oneEmployeeLinked || !user?.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const update = {};
        const allowed = ['projectId', 'projectName', 'bhkPreference', 'budgetRange', 'preferredLocation', 'timeline', 'loanRequired'];
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                update[`propertyInterest.${key}`] = req.body[key];
            }
        }

        const journey = await LeadJourney.findOneAndUpdate(
            { leadId, ownerId: user.oneEmployeeOwnerId },
            { $set: update },
            { new: true, upsert: true }
        );

        return res.json({ success: true, propertyInterest: journey.propertyInterest });
    } catch (err) {
        logger.error('updatePropertyInterest error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/journey/funnel
 * Returns funnel stats — count of leads at each stage.
 * Used for the pipeline/funnel dashboard view.
 */
exports.getFunnel = async (req, res) => {
    try {
        const User = require('../models/User');
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user?.oneEmployeeLinked || !user?.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const funnel = await LeadJourney.aggregate([
            { $match: { ownerId: user.oneEmployeeOwnerId } },
            { $group: { _id: '$currentStage', count: { $sum: 1 } } },
        ]);

        // Build ordered funnel response
        const result = {};
        let total = 0;
        for (const stage of [...STAGE_ORDER, 'lost']) {
            const found = funnel.find(f => f._id === stage);
            result[stage] = {
                count: found?.count || 0,
                label: STAGE_LABELS[stage],
            };
            total += found?.count || 0;
        }

        // Conversion metrics
        const converted = result.deal_closed.count;
        const lost = result.lost.count;
        const conversionRate = total > 0 ? ((converted / total) * 100).toFixed(1) : 0;

        return res.json({
            funnel: result,
            total,
            converted,
            lost,
            conversionRate: Number(conversionRate),
            stageOrder: STAGE_ORDER,
        });
    } catch (err) {
        logger.error('getFunnel error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/journey/recent
 * Returns recently updated journeys (for activity feed).
 * Query: limit (default 20)
 */
exports.getRecentActivity = async (req, res) => {
    try {
        const User = require('../models/User');
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user?.oneEmployeeLinked || !user?.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const limit = Math.min(50, parseInt(req.query.limit) || 20);

        const journeys = await LeadJourney.find({ ownerId: user.oneEmployeeOwnerId })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .select('leadId currentStage leadSnapshot updatedAt timeline')
            .lean();

        // Get latest timeline entry for each
        const activity = journeys.map(j => ({
            leadId: j.leadId,
            leadName: `${j.leadSnapshot?.firstName || ''} ${j.leadSnapshot?.lastName || ''}`.trim() || 'Unknown',
            phone: j.leadSnapshot?.phone,
            currentStage: j.currentStage,
            currentStageLabel: STAGE_LABELS[j.currentStage],
            lastActivity: j.timeline?.[j.timeline.length - 1],
            updatedAt: j.updatedAt,
        }));

        return res.json({ activity });
    } catch (err) {
        logger.error('getRecentActivity error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};
