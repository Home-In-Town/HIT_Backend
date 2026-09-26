const HumanLead = require('../models/HumanLead');
const User = require('../models/User');
const LeadPropertyMatch = require('../models/LeadPropertyMatch');
const mapper = require('../services/LeadRequirementMapper');
const humanLeadMatchService = require('../services/HumanLeadMatchService');

const QUALIFIED_STAGE = HumanLead.QUALIFIED_STAGE;

// Fields the client may set when creating/updating a lead.
// `requirements` is handled separately — it is normalised server-side rather
// than copied through verbatim, because the engine is unit-sensitive and the
// client must not be trusted to send lakhs/sqft correctly.
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
 * - captain → sees leads owned by their team (owningCaptain === me), created by them,
 *             OR owned by a partner (teamed-up) captain
 * - agent   → sees their team's leads (owningCaptain === my captain) or leads they created/are assigned
 *
 * `partnerIds` is the caller's list of teamed-up captain ids (empty unless captain).
 */
function visibilityFilter(user, partnerIds = []) {
  if (user.role === 'admin') return {};

  if (user.role === 'captain') {
    const or = [{ owningCaptain: user._id }, { createdBy: user._id }];
    if (partnerIds.length) or.push({ owningCaptain: { $in: partnerIds } });
    return { $or: or };
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

// Fetch the caller's confirmed partner-captain ids (only relevant for captains)
async function getPartnerIds(user) {
  if (user.role !== 'captain') return [];
  const me = await User.findById(user._id).select('partnerCaptains').lean();
  return (me?.partnerCaptains || []).map((p) => p.toString());
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

    // Structured requirements, normalised server-side (budget → lakhs,
    // area → sqft, locality/city split, canonical location derived).
    if (req.body.requirements && typeof req.body.requirements === 'object') {
      data.requirements = mapper.normalizeRequirements(req.body.requirements);
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

    // A lead can be created directly as Qualified. Treat that exactly like
    // moving it to Qualified: validate the requirements, then match.
    const createdQualified = data.stage === QUALIFIED_STAGE;
    if (createdQualified) {
      const check = mapper.isMatchable({ ...data });
      if (!check.ok) {
        return res.status(400).json({
          error: 'INCOMPLETE_REQUIREMENTS',
          message: 'Add the missing requirement details before qualifying this lead.',
          missing: check.missing,
        });
      }
      data.qualifiedAt = new Date();
      data.qualifiedBy = req.user._id;
      data.matchingEnabled = true;
    }

    let lead = await HumanLead.create(data);

    let matching = null;
    if (createdQualified) {
      matching = await runMatching(lead, 'qualification');
    }

    lead = await HumanLead.findById(lead._id).populate(POPULATE).lean();

    return res.status(201).json({ lead: shape(lead), matching });
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
    const partnerIds = await getPartnerIds(req.user);

    const filter = { ...visibilityFilter(req.user, partnerIds) };
    filter.archived = archived === 'true';
    if (stage && stage !== 'All') filter.stage = stage;

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const searchOr = [{ name: rx }, { phone: rx }, { projectName: rx }];
      // Combine the visibility $or with the search $or via $and
      const vis = visibilityFilter(req.user, partnerIds);
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
    const partnerIds = await getPartnerIds(req.user);
    if (!canAccess(req.user, lead, partnerIds)) return res.status(403).json({ error: 'Not authorized to view this lead' });
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
    const partnerIds = await getPartnerIds(req.user);
    if (!canAccess(req.user, lead, partnerIds)) return res.status(403).json({ error: 'Not authorized' });

    const from = lead.stage;
    const becomingQualified = stage === QUALIFIED_STAGE && from !== QUALIFIED_STAGE;

    // Validate BEFORE mutating. Qualification is the gate that turns a lead into
    // something the matching engine will act on, so it must not be possible to
    // qualify a lead that cannot produce trustworthy matches.
    if (becomingQualified) {
      const check = mapper.isMatchable(lead);
      if (!check.ok) {
        return res.status(400).json({
          error: 'INCOMPLETE_REQUIREMENTS',
          message: 'Add the missing requirement details before qualifying this lead.',
          missing: check.missing,
        });
      }
    }

    lead.stage = stage;
    lead.stageHistory.push({ from, to: stage, changedBy: req.user._id });

    if (becomingQualified) {
      lead.qualifiedAt = new Date();
      lead.qualifiedBy = req.user._id;
      // Stays true from here on, so a project published months later still
      // finds this lead via ReverseMatchService.
      lead.matchingEnabled = true;
      lead.matchingSkippedReason = null;
    }

    await lead.save();

    // Run matching inline for a qualification so the agent immediately sees the
    // real matched properties in the response. Notification delivery is not
    // built yet, so this response IS how the agent currently learns about a
    // match — worth the extra latency on a deliberate action.
    // matchQualifiedLead never throws, so it cannot fail the stage change (which
    // is already persisted above).
    let matching = null;
    if (becomingQualified) {
      matching = await runMatching(lead, 'qualification');
    }

    const populated = await HumanLead.findById(lead._id).populate(POPULATE).lean();
    return res.json({ lead: shape(populated), matching });
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
    const partnerIds = await getPartnerIds(req.user);
    if (!canAccess(req.user, lead, partnerIds)) return res.status(403).json({ error: 'Not authorized' });

    for (const key of LEAD_FIELDS) {
      if (req.body[key] !== undefined && key !== 'stage') lead[key] = req.body[key];
    }

    // Requirements are MERGED, not replaced, so a partial patch (e.g. only the
    // budget) cannot silently wipe the rest of the requirement set.
    let requirementsChanged = false;
    if (req.body.requirements && typeof req.body.requirements === 'object') {
      const existing = lead.requirements
        ? (typeof lead.requirements.toObject === 'function' ? lead.requirements.toObject() : { ...lead.requirements })
        : {};
      lead.requirements = { ...existing, ...mapper.normalizeRequirements(req.body.requirements) };
      requirementsChanged = true;
    }

    await lead.save();

    const populated = await HumanLead.findById(lead._id).populate(POPULATE).lean();

    // Editing the requirements of an already-qualified lead leaves its existing
    // matches stale. Matching is NOT re-run automatically here (that would make
    // every keystroke-level save do engine work); the client is told to offer a
    // rematch instead.
    const rematchRecommended = requirementsChanged && !!populated.matchingEnabled;

    return res.json({ lead: shape(populated), rematchRecommended });
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
      const target = await User.findById(agentId).select('employerId role name');
      if (!target) return res.status(400).json({ error: 'Agent not found' });

      const me = await User.findById(req.user._id).select('partnerCaptains').lean();
      const partnerIds = (me?.partnerCaptains || []).map((p) => p.toString());
      const isPartnerCaptain = target.role === 'captain' && partnerIds.includes(target._id.toString());

      if (isPartnerCaptain) {
        // Handing the lead to a partner captain — transfer team ownership to them
        // so their whole team gets visibility, and assign it to that captain.
        lead.owningCaptain = target._id;
        lead.assignedAgent = target._id;
      } else {
        // Otherwise it must be one of the captain's own agents (or the captain themselves)
        const agentCaptain = target.employerId ? target.employerId.toString() : null;
        const owning = lead.owningCaptain ? lead.owningCaptain.toString() : req.user._id.toString();
        const assigningToSelf = target._id.toString() === req.user._id.toString();
        if (!assigningToSelf && agentCaptain !== owning) {
          return res.status(400).json({ error: 'Agent is not part of your team' });
        }
        lead.assignedAgent = agentId;
      }
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
    // Only captains manage assignment.
    if (req.user.role !== 'captain') {
      return res.json({ agents: [] });
    }

    // The captain's own confirmed agents/employees
    const agentQuery = { employerId: req.user._id, isEmployerConfirmed: true, role: { $in: ['agent', 'employee'] } };
    const agents = await User.find(agentQuery).select('_id name phone role').sort({ name: 1 }).lean();

    // Plus any teamed-up partner captains (so leads can be handed to a partner)
    const me = await User.findById(req.user._id)
      .populate('partnerCaptains', 'name phone role companyName')
      .lean();
    const partners = (me?.partnerCaptains || []).map((c) => ({
      id: c._id.toString(),
      name: c.companyName ? `${c.name} (${c.companyName})` : c.name,
      phone: c.phone,
      role: 'captain',
    }));

    const list = [
      ...agents.map((a) => ({ id: a._id.toString(), name: a.name, phone: a.phone, role: a.role })),
      ...partners,
    ];
    return res.json({ agents: list });
  } catch (err) {
    console.error('getTeamAgents error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/human-leads/:id/matches
 * Real matched properties for a lead, strongest first.
 *
 * Reads from LeadPropertyMatch (the authoritative Lead → Property relationship)
 * and populates each project, so every field on the card is real data from the
 * Projects collection — no mock values and nothing recomputed at read time.
 */
exports.getMatches = async (req, res) => {
  try {
    const lead = await HumanLead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const partnerIds = await getPartnerIds(req.user);
    if (!canAccess(req.user, lead, partnerIds)) {
      return res.status(403).json({ error: 'Not authorized to view this lead' });
    }

    const matches = await humanLeadMatchService.getMatchesForLead(lead._id, {
      includeDismissed: req.query.includeDismissed === 'true',
    });

    const check = mapper.isMatchable(lead);

    return res.json({
      matches,
      total: matches.length,
      // Context so the UI can explain an empty list instead of just showing
      // "no matches": not qualified yet / rent / missing fields / genuinely none.
      qualified: !!lead.qualifiedAt || lead.stage === QUALIFIED_STAGE,
      matchingEnabled: !!lead.matchingEnabled,
      matchingSkippedReason: lead.matchingSkippedReason || null,
      lastMatchRunAt: lead.lastMatchRunAt || null,
      requirementsComplete: check.ok,
      requirementsMissing: check.missing,
    });
  } catch (err) {
    console.error('getMatches error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/human-leads/:id/rematch
 * Re-run matching for an already-qualified lead (e.g. after editing its
 * requirements). Safe to call repeatedly — LeadPropertyMatch's unique index
 * makes re-runs refresh scores rather than create duplicates.
 */
exports.rematchLead = async (req, res) => {
  try {
    const lead = await HumanLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const partnerIds = await getPartnerIds(req.user);
    if (!canAccess(req.user, lead, partnerIds)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!lead.matchingEnabled) {
      return res.status(400).json({
        error: 'NOT_QUALIFIED',
        message: `Move the lead to "${QUALIFIED_STAGE}" before matching properties.`,
      });
    }

    const check = mapper.isMatchable(lead);
    if (!check.ok) {
      return res.status(400).json({
        error: 'INCOMPLETE_REQUIREMENTS',
        message: 'Add the missing requirement details to match properties.',
        missing: check.missing,
      });
    }

    const matching = await runMatching(lead, 'manual_rematch');

    const populated = await HumanLead.findById(lead._id).populate(POPULATE).lean();
    return res.json({ lead: shape(populated), matching });
  } catch (err) {
    console.error('rematchLead error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/human-leads/:id/matches/:matchId/dismiss
 * Hide a match an agent judged irrelevant. The row is kept (not deleted) so
 * re-scoring cannot silently resurrect it.
 */
exports.dismissMatch = async (req, res) => {
  try {
    const lead = await HumanLead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const partnerIds = await getPartnerIds(req.user);
    if (!canAccess(req.user, lead, partnerIds)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Scoped by lead as well as matchId, so one lead's match can never be
    // dismissed through another lead's URL.
    const updated = await LeadPropertyMatch.findOneAndUpdate(
      { _id: req.params.matchId, lead: lead._id, leadModel: 'HumanLead' },
      { $set: { dismissed: true, dismissedBy: req.user._id, dismissedAt: new Date() } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Match not found for this lead' });

    const summary = await humanLeadMatchService.refreshLeadMatchSummary(lead._id);

    return res.json({
      dismissed: true,
      matchId: String(updated._id),
      matchCount: summary.matchCount,
      bestMatchScore: summary.bestMatchScore,
    });
  } catch (err) {
    console.error('dismissMatch error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ──

/**
 * Run property matching for a lead and shape the outcome for an API response.
 *
 * Never throws (HumanLeadMatchService swallows its own failures), so callers can
 * await it without risking the request that triggered it.
 */
async function runMatching(lead, matchSource) {
  const result = await humanLeadMatchService.matchQualifiedLead(lead, { matchSource });
  return {
    ran: result.ran,
    skippedReason: result.skippedReason,
    missing: result.missing,
    matches: result.matches,
    newCount: result.newCount,
    total: result.total,
    error: result.error,
  };
}

// True if this user is allowed to see/act on a given lead.
// `partnerIds` = caller's teamed-up captain ids (so partners can collaborate).
function canAccess(user, lead, partnerIds = []) {
  if (user.role === 'admin') return true;
  const uid = user._id.toString();
  const createdBy = lead.createdBy?._id ? lead.createdBy._id.toString() : lead.createdBy?.toString();
  const assigned = lead.assignedAgent?._id ? lead.assignedAgent._id.toString() : lead.assignedAgent?.toString();
  const owning = lead.owningCaptain?._id ? lead.owningCaptain._id.toString() : lead.owningCaptain?.toString();

  if (createdBy === uid || assigned === uid) return true;
  if (user.role === 'captain') {
    return owning === uid || (owning && partnerIds.includes(owning));
  }
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

  // Effective requirements + what's still missing, so the UI can show a
  // "complete these to qualify" hint without duplicating the rules client-side.
  const check = mapper.isMatchable(lead);

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

    // ── Structured requirements (property matching) ──
    requirements: lead.requirements || {},
    requirementsComplete: check.ok,
    requirementsMissing: check.missing,
    // Which requirement values were inferred from the legacy free-text fields
    // rather than entered structurally — lets the UI ask for confirmation.
    requirementsDerivedFrom: check.derivedFrom,

    // ── Qualification / matching state ──
    qualifiedAt: lead.qualifiedAt || null,
    matchingEnabled: !!lead.matchingEnabled,
    matchingSkippedReason: lead.matchingSkippedReason || null,
    lastMatchRunAt: lead.lastMatchRunAt || null,
    matchCount: lead.matchCount || 0,
    bestMatchScore: lead.bestMatchScore || 0,
  };
}

module.exports = exports;
