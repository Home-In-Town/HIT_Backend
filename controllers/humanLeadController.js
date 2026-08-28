const HumanLead = require('../models/HumanLead');
const User = require('../models/User');

// Fields the client may set when creating/updating a lead
const LEAD_FIELDS = [
  'name', 'phone', 'altPhone', 'email', 'budget', 'homeType',
  'buyingType', 'location', 'projectName', 'source', 'leadType',
  'stage', 'siteVisitDate', 'siteVisitTime',
];

// Population spec so every lead shows who brought it and who it's assigned to
const POPULATE = [
  { path: 'createdBy', select: 'name role phone' },
  { path: 'owningCaptain', select: 'name role companyName' },
  { path: 'assignedAgent', select: 'name role phone' },
];

/**
 * Resolve the owning captain for a lead based on who is creating it.
 * - captain  → themselves
 * - agent    → their employer (captain), if confirmed
 * - admin    → no team (null) unless they are also under a captain
 */
function resolveOwningCaptain(user) {
  if (user.role === 'captain') return user._id;
  if (user.role === 'agent' || user.role === 'employee') {
    // employerId may be populated (object) or a raw id
    const emp = user.employerId;
    if (!emp) return null;
    return emp._id ? emp._id : emp;
  }
  return null; // admin / builder / others — no captain team
}

/**
 * Build the Mongo filter that enforces visibility rules for the caller.
 * - admin   → sees everything
 * - captain → sees leads owned by their team (owningCaptain === me) or created by them
 * - agent   → sees their team's leads (owningCaptain === my captain) or leads they created/are assigned
 */
function visibilityFilter(user) {
  if (user.role === 'admin') return {};

  if (user.role === 'captain') {
    return { $or: [{ owningCaptain: user._id }, { createdBy: user._id }] };
  }

  if (user.role === 'agent' || user.role === 'employee') {
    const emp = user.employerId;
    const captainId = emp ? (emp._id ? emp._id : emp) : null;
    const or = [{ createdBy: user._id }, { assignedAgent: user._id }];
    if (captainId) or.push({ owningCaptain: captainId });
    return { $or: or };
  }

  // builder / other roles — only their own
  return { $or: [{ createdBy: user._id }, { assignedAgent: user._id }] };
}

/**
 * POST /api/human-leads
 * Create a lead. Ownership is derived from the creator's role.
 */
exports.createLead = async (req, res) => {
  try {
    const data = {};
    for (const key of LEAD_FIELDS) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    if (!data.name || !data.phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    data.createdBy = req.user._id;
    data.owningCaptain = resolveOwningCaptain(req.user);

    // A captain creating a lead is assigned it by default; an agent is assigned their own lead.
    if (req.body.assignedAgent) {
      data.assignedAgent = req.body.assignedAgent;
    } else if (req.user.role === 'agent' || req.user.role === 'employee') {
      data.assignedAgent = req.user._id;
    } else if (req.user.role === 'captain') {
      data.assignedAgent = req.user._id;
    }

    data.stageHistory = [{ to: data.stage || 'New Lead', changedBy: req.user._id }];

    let lead = await HumanLead.create(data);
    lead = await HumanLead.findById(lead._id).populate(POPULATE);

    return res.status(201).json({ lead });
  } catch (err) {
    console.error('createLead error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/human-leads
 * List leads visible to the caller (team-scoped).
 */
exports.getLeads = async (req, res) => {
  try {
    const { stage, search, archived } = req.query;

    const filter = { ...visibilityFilter(req.user) };
    filter.archived = archived === 'true';
    if (stage && stage !== 'All') filter.stage = stage;

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const searchOr = [{ name: rx }, { phone: rx }, { projectName: rx }];
      // Combine the visibility $or with the search $or via $and
      const vis = visibilityFilter(req.user);
      const base = { archived: filter.archived };
      if (stage && stage !== 'All') base.stage = stage;
      const and = [base, { $or: searchOr }];
      if (vis.$or) and.push({ $or: vis.$or });
      const leads = await HumanLead.find({ $and: and }).populate(POPULATE).sort({ updatedAt: -1 }).lean();
      return res.json({ leads: leads.map(shape) });
    }

    const leads = await HumanLead.find(filter).populate(POPULATE).sort({ updatedAt: -1 }).lean();
    return res.json({ leads: leads.map(shape) });
  } catch (err) {
    console.error('getLeads error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/human-leads/:id
 */
exports.getLeadById = async (req, res) => {
  try {
    const lead = await HumanLead.findById(req.params.id).populate(POPULATE).lean();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccess(req.user, lead)) return res.status(403).json({ error: 'Not authorized to view this lead' });
    return res.json({ lead: shape(lead) });
  } catch (err) {
    console.error('getLeadById error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/human-leads/:id/stage
 */
exports.updateStage = async (req, res) => {
  try {
    const { stage } = req.body;
    if (!stage) return res.status(400).json({ error: 'stage is required' });

    const lead = await HumanLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccess(req.user, lead)) return res.status(403).json({ error: 'Not authorized' });

    const from = lead.stage;
    lead.stage = stage;
    lead.stageHistory.push({ from, to: stage, changedBy: req.user._id });
    await lead.save();

    const populated = await HumanLead.findById(lead._id).populate(POPULATE).lean();
    return res.json({ lead: shape(populated) });
  } catch (err) {
    console.error('updateStage error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/human-leads/:id
 * Update editable lead fields (e.g. site visit date/time, project, etc.)
 */
exports.updateLead = async (req, res) => {
  try {
    const lead = await HumanLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccess(req.user, lead)) return res.status(403).json({ error: 'Not authorized' });

    for (const key of LEAD_FIELDS) {
      if (req.body[key] !== undefined && key !== 'stage') lead[key] = req.body[key];
    }
    await lead.save();

    const populated = await HumanLead.findById(lead._id).populate(POPULATE).lean();
    return res.json({ lead: shape(populated) });
  } catch (err) {
    console.error('updateLead error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/human-leads/:id/assign
 * Assign the lead to a team agent (or the captain themselves). Captain only.
 * Body: { agentId } — null to unassign.
 */
exports.assignAgent = async (req, res) => {
  try {
    const { agentId } = req.body;

    // Assignment is a captain-only capability
    if (req.user.role !== 'captain') {
      return res.status(403).json({ error: 'Only a captain can assign leads' });
    }

    const lead = await HumanLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // The captain must own the team this lead belongs to
    const isOwningCaptain = lead.owningCaptain && lead.owningCaptain.toString() === req.user._id.toString();
    if (!isOwningCaptain && lead.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only assign leads that belong to your team' });
    }

    if (agentId) {
      // Validate the agent belongs to the captain's team (or is the captain themselves)
      const agent = await User.findById(agentId).select('employerId role name');
      if (!agent) return res.status(400).json({ error: 'Agent not found' });
      const agentCaptain = agent.employerId ? agent.employerId.toString() : null;
      const owning = lead.owningCaptain ? lead.owningCaptain.toString() : req.user._id.toString();
      const assigningToSelf = agent._id.toString() === req.user._id.toString();
      if (!assigningToSelf && agentCaptain !== owning) {
        return res.status(400).json({ error: 'Agent is not part of your team' });
      }
      lead.assignedAgent = agentId;
    } else {
      lead.assignedAgent = null;
    }
    await lead.save();

    const populated = await HumanLead.findById(lead._id).populate(POPULATE).lean();
    return res.json({ lead: shape(populated) });
  } catch (err) {
    console.error('assignAgent error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/human-leads/team-agents
 * Returns the confirmed agents a captain can assign leads to.
 * Assignment is a captain-only capability; other roles get an empty list.
 */
exports.getTeamAgents = async (req, res) => {
  try {
    // Only captains manage assignment — return the captain's own confirmed agents/employees.
    if (req.user.role !== 'captain') {
      return res.json({ agents: [] });
    }
    const query = { employerId: req.user._id, isEmployerConfirmed: true, role: { $in: ['agent', 'employee'] } };
    const agents = await User.find(query).select('_id name phone role').sort({ name: 1 }).lean();
    return res.json({ agents: agents.map(a => ({ id: a._id.toString(), name: a.name, phone: a.phone, role: a.role })) });
  } catch (err) {
    console.error('getTeamAgents error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ──

// True if this user is allowed to see/act on a given lead
function canAccess(user, lead) {
  if (user.role === 'admin') return true;
  const uid = user._id.toString();
  const createdBy = lead.createdBy?._id ? lead.createdBy._id.toString() : lead.createdBy?.toString();
  const assigned = lead.assignedAgent?._id ? lead.assignedAgent._id.toString() : lead.assignedAgent?.toString();
  const owning = lead.owningCaptain?._id ? lead.owningCaptain._id.toString() : lead.owningCaptain?.toString();

  if (createdBy === uid || assigned === uid) return true;
  if (user.role === 'captain') return owning === uid;
  if (user.role === 'agent' || user.role === 'employee') {
    const emp = user.employerId;
    const captainId = emp ? (emp._id ? emp._id.toString() : emp.toString()) : null;
    return captainId && owning === captainId;
  }
  return false;
}

// Flatten a populated lead into the shape the frontend expects
function shape(lead) {
  const person = (p) => (p && p._id ? { id: p._id.toString(), name: p.name, role: p.role } : null);
  return {
    id: lead._id.toString(),
    name: lead.name,
    phone: lead.phone,
    altPhone: lead.altPhone || '',
    email: lead.email || '',
    budget: lead.budget || '',
    homeType: lead.homeType || '',
    buyingType: lead.buyingType || '',
    location: lead.location || '',
    project: lead.projectName || 'Unassigned',
    source: lead.source || 'Manual',
    leadType: lead.leadType || 'inbound',
    stage: lead.stage,
    siteVisitDate: lead.siteVisitDate || undefined,
    siteVisitTime: lead.siteVisitTime || undefined,
    date: new Date(lead.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    createdBy: person(lead.createdBy),
    owningCaptain: person(lead.owningCaptain),
    assignedAgent: person(lead.assignedAgent),
  };
}

module.exports = exports;
