const CrmLead = require('../models/CrmLead');
const Notification = require('../models/Notification');

/**
 * POST /api/crm/leads
 * Create a new CRM lead
 */
exports.createLead = async (req, res) => {
  try {
    const { project, leadContact, stage, priority, source, estimatedValue, notes, tags } = req.body;
    const owner = req.user._id;

    const lead = await CrmLead.create({
      project,
      owner,
      leadContact,
      stage: stage || 'New',
      priority: priority || 'medium',
      source: source || 'manual',
      estimatedValue: estimatedValue || 0,
      notes: notes ? [{ content: notes, addedBy: owner }] : [],
      tags: tags || [],
      stageHistory: [{ to: stage || 'New', changedBy: owner }]
    });

    await lead.populate('leadContact', 'name phone role companyName');
    await lead.populate('project', 'projectName');

    res.status(201).json({ lead });
  } catch (err) {
    console.error('createLead error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/crm/leads
 * Get all leads for the authenticated user (pipeline view)
 */
exports.getLeads = async (req, res) => {
  try {
    const owner = req.user._id;
    const { stage, priority, archived, search } = req.query;

    const filter = { owner, archived: archived === 'true' };

    if (stage) filter.stage = stage;
    if (priority) filter.priority = priority;

    const leads = await CrmLead.find(filter)
      .populate('leadContact', 'name phone role companyName')
      .populate('project', 'projectName city location')
      .populate('notes.addedBy', 'name')
      .sort({ updatedAt: -1 });

    res.status(200).json({ leads });
  } catch (err) {
    console.error('getLeads error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/crm/leads/:id
 * Get a single lead with full details
 */
exports.getLeadById = async (req, res) => {
  try {
    const lead = await CrmLead.findOne({ _id: req.params.id, owner: req.user._id })
      .populate('leadContact', 'name phone role companyName')
      .populate('project', 'projectName city location')
      .populate('stageHistory.changedBy', 'name')
      .populate('notes.addedBy', 'name');

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.status(200).json({ lead });
  } catch (err) {
    console.error('getLeadById error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/crm/leads/:id/stage
 * Update lead pipeline stage (with notification)
 */
exports.updateLeadStage = async (req, res) => {
  try {
    const { stage, notes } = req.body;
    const userId = req.user._id;

    const lead = await CrmLead.findOne({ _id: req.params.id, owner: userId });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const previousStage = lead.stage;
    lead.stage = stage;
    lead.stageHistory.push({
      from: previousStage,
      to: stage,
      changedBy: userId,
      notes: notes || ''
    });

    await lead.save();
    await lead.populate('leadContact', 'name phone role companyName');

    // Send notification about stage change
    await Notification.create({
      recipient: userId,
      type: 'lead_stage_change',
      title: 'Lead Stage Updated',
      message: `Lead "${lead.leadContact?.name || 'Unknown'}" moved from ${previousStage} to ${stage}`,
      reference: { model: 'CrmLead', id: lead._id }
    });

    // Emit via socket
    if (req.app.get('io')) {
      req.app.get('io').to(userId.toString()).emit('notification', {
        type: 'lead_stage_change',
        title: 'Lead Stage Updated',
        message: `Lead moved from ${previousStage} to ${stage}`,
        leadId: lead._id
      });
    }

    res.status(200).json({ lead });
  } catch (err) {
    console.error('updateLeadStage error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/crm/leads/:id
 * Update lead details (priority, notes, tags, followUp, estimatedValue)
 */
exports.updateLead = async (req, res) => {
  try {
    const { priority, tags, nextFollowUp, estimatedValue, note } = req.body;
    const userId = req.user._id;

    const lead = await CrmLead.findOne({ _id: req.params.id, owner: userId });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (priority) lead.priority = priority;
    if (tags) lead.tags = tags;
    if (nextFollowUp !== undefined) lead.nextFollowUp = nextFollowUp;
    if (estimatedValue !== undefined) lead.estimatedValue = estimatedValue;
    if (note) {
      lead.notes.push({ content: note, addedBy: userId });
    }

    await lead.save();
    await lead.populate('leadContact', 'name phone role companyName');
    await lead.populate('project', 'projectName');

    res.status(200).json({ lead });
  } catch (err) {
    console.error('updateLead error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE /api/crm/leads/:id
 * Archive a lead (soft delete)
 */
exports.archiveLead = async (req, res) => {
  try {
    const lead = await CrmLead.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { archived: true },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.status(200).json({ message: 'Lead archived', lead });
  } catch (err) {
    console.error('archiveLead error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/crm/pipeline-stats
 * Get pipeline statistics for dashboard
 */
exports.getPipelineStats = async (req, res) => {
  try {
    const owner = req.user._id;

    const stats = await CrmLead.aggregate([
      { $match: { owner, archived: false } },
      {
        $group: {
          _id: '$stage',
          count: { $sum: 1 },
          totalValue: { $sum: '$estimatedValue' }
        }
      }
    ]);

    const totalLeads = stats.reduce((sum, s) => sum + s.count, 0);
    const totalValue = stats.reduce((sum, s) => sum + s.totalValue, 0);

    res.status(200).json({
      pipeline: stats,
      totalLeads,
      totalValue
    });
  } catch (err) {
    console.error('getPipelineStats error:', err);
    res.status(500).json({ error: err.message });
  }
};
