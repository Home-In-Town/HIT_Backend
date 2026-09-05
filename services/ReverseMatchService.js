/**
 * ReverseMatchService
 * 
 * When a builder publishes a new project, this service:
 *   1. Queries recent ExtractedLeads (last 7 days) that could match the new inventory
 *   2. Scores each lead against the new project using MatchEngineV2's scoring logic
 *   3. Notifies the original agents who posted those requirements
 *   4. Notifies admins of the reverse matches
 * 
 * This closes the loop: agents don't have to re-post requirements every day.
 * If new inventory matches their existing need, they get alerted automatically.
 * 
 * Called from:
 *   - ProjectController.publish (main publish flow)
 *   - internalRoutes (OneEmployee create/update with status='published')
 */

const ExtractedLead = require('../models/ExtractedLead');
const Notification = require('../models/Notification');
const User = require('../models/User');
const locationNormalizer = require('./LocationNormalizer');
const propertyTypeNormalizer = require('./PropertyTypeNormalizer');
const Logger = require('../utils/logger');

const logger = new Logger('ReverseMatch');

// How far back to look for matching leads (6 months).
const LOOKBACK_DAYS = 180;
// Minimum score to consider a reverse match valid
const MIN_REVERSE_SCORE = 35;
// Max leads to check per project publish (performance guard)
const MAX_LEADS_TO_CHECK = 100;
// Max matches to notify about (don't spam)
const MAX_NOTIFICATIONS = 10;

class ReverseMatchService {

  /**
   * Run reverse matching for a newly published project.
   * Non-blocking — should be called fire-and-forget from controllers.
   * 
   * @param {object} project - The published project (full document or lean object)
   * @param {object} [io] - Socket.io instance for real-time notifications
   */
  async onProjectPublished(project, io) {
    const startTime = Date.now();

    try {
      if (!project || !project._id) {
        logger.error('onProjectPublished called without valid project');
        return;
      }

      logger.info('Reverse match started', {
        projectId: project._id,
        projectName: project.projectName,
        location: project.location,
        city: project.city
      });

      // Step 1: Find recent leads that could match this project
      const candidateLeads = await this._findCandidateLeads(project);

      if (candidateLeads.length === 0) {
        logger.info('No candidate leads found for reverse match', {
          projectId: project._id
        });
        return;
      }

      // Step 2: Score each lead against this project
      const scoredMatches = this._scoreLeadsAgainstProject(candidateLeads, project);

      // Step 3: Filter by minimum score
      const validMatches = scoredMatches
        .filter(m => m.score >= MIN_REVERSE_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_NOTIFICATIONS);

      if (validMatches.length === 0) {
        logger.info('No valid reverse matches above threshold', {
          projectId: project._id,
          candidatesChecked: candidateLeads.length
        });
        return;
      }

      logger.info(`Found ${validMatches.length} reverse matches`, {
        projectId: project._id,
        topScore: validMatches[0].score
      });

      // Step 4: Notify original agents
      await this._notifyAgents(validMatches, project, io);

      // Step 4.5: Auto-create/join the project sub-group for each matched agent,
      // mirroring the forward path (LeadCaptureService). This pulls the original
      // requester into a deal room automatically when matching inventory is
      // published later — closing the loop for "requirement now, inventory later".
      await this._createSubGroupsForMatches(validMatches, project, io);

      // Step 5: Notify admins
      await this._notifyAdmins(validMatches, project, io);

      // Step 6: Update the ExtractedLeads with reverse match info
      await this._updateLeadsWithReverseMatch(validMatches, project);

      const elapsed = Date.now() - startTime;
      logger.info(`Reverse match completed in ${elapsed}ms`, {
        projectId: project._id,
        matchesFound: validMatches.length,
        leadsChecked: candidateLeads.length
      });

    } catch (err) {
      logger.error('Reverse match error (non-blocking)', {
        error: err.message,
        projectId: project?._id
      });
    }
  }

  // ─── Step 1: Find Candidate Leads ──────────────────────────────────────────

  async _findCandidateLeads(project) {
    const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Build a query that narrows down leads likely to match this project
    const filter = {
      status: { $in: ['auto_detected', 'confirmed'] }, // Not rejected/expired
      createdAt: { $gte: lookbackDate },
      // Exclude leads from the project owner themselves
      extractedBy: { $ne: project.owner?._id || project.owner }
    };

    // Narrow by city if available
    if (project.city) {
      filter.$or = [
        { 'params.city': { $regex: project.city, $options: 'i' } },
        { 'params.city': null } // Also include leads without city (could still match by location)
      ];
    }

    // Narrow by BHK when the project is a BHK-bearing type (flats/villas).
    // IMPORTANT: never hard-exclude leads that have no BHK — plot / farm-land /
    // mixed-use buyers legitimately post requirements without a BHK, and a
    // land/plot project has no meaningful bhkOptions to filter on. So the BHK
    // narrowing is only an OPTIMISATION arm, always OR'd with "no BHK on lead".
    const projType = propertyTypeNormalizer.fromProject(project);
    const projectIsLand = ['plot', 'farm_land', 'commercial_plot'].includes(projType.family);

    if (!projectIsLand && project.configuration?.bhkOptions?.length > 0) {
      const bhkNumbers = project.configuration.bhkOptions
        .map(opt => opt.match(/(\d)/))
        .filter(Boolean)
        .map(m => `${m[1]}BHK`);
      // Include adjacent BHK so a 2BHK project still surfaces 1/3 BHK leads
      // (scoring gives them partial credit, same as the forward engine).
      const withAdjacent = new Set();
      for (const b of bhkNumbers) {
        const n = parseInt(b);
        withAdjacent.add(`${n}BHK`);
        if (n - 1 >= 1) withAdjacent.add(`${n - 1}BHK`);
        withAdjacent.add(`${n + 1}BHK`);
      }

      if (withAdjacent.size > 0) {
        const bhkClause = {
          $or: [
            { 'params.bhkType': { $in: [...withAdjacent] } },
            { 'params.bhkType': { $exists: false } },
            { 'params.bhkType': null }
          ]
        };
        filter.$and = (filter.$and || []).concat([bhkClause]);
      }
    }

    const leads = await ExtractedLead.find(filter)
      .populate('extractedBy', 'name role phone')
      .sort({ createdAt: -1 })
      .limit(MAX_LEADS_TO_CHECK)
      .lean();

    return leads;
  }

  // ─── Step 2: Score Leads Against Project ───────────────────────────────────

  _scoreLeadsAgainstProject(leads, project) {
    const results = [];

    for (const lead of leads) {
      const score = this._calculateReverseScore(lead.params, project);
      if (score.total > 0) {
        results.push({
          lead,
          score: score.total,
          breakdown: score.breakdown,
          matchedOn: score.matchedOn
        });
      }
    }

    return results;
  }

  /**
   * Score a single lead's params against a project.
   *
   * Weights are kept IN SYNC with MatchEngineV2._calculateScore so that a given
   * (lead, project) pair scores identically whether it was surfaced by forward
   * matching (requirement → projects) or reverse matching (project → leads):
   *
   *   budget 28 | location 28 | propertyType 18 | bhk 14 (skipped for land)
   *   loan 6    | possession 6 | verified +3    | rera +2   | capped at 100
   *
   * Plus a location penalty when the lead names a location that doesn't match.
   */
  _calculateReverseScore(params, project) {
    const breakdown = {};
    const matchedOn = [];
    let total = 0;

    // === Budget Match (28 points) ===
    if (params.budget && project.pricing?.startingPrice) {
      const reqBudget = params.budget * 100000; // lakhs → value
      const reqBudgetMax = params.budgetMax ? params.budgetMax * 100000 : reqBudget * 1.1;
      const projPrice = project.pricing.startingPrice;

      // Check if project price falls within the lead's budget range
      const isInRange = projPrice >= (reqBudget * 0.8) && projPrice <= (reqBudgetMax * 1.2);
      if (isInRange) {
        const diff = Math.abs(reqBudget - projPrice) / reqBudget;
        if (diff <= 0.05) { total += 28; breakdown.budget = 28; }
        else if (diff <= 0.10) { total += 24; breakdown.budget = 24; }
        else if (diff <= 0.15) { total += 19; breakdown.budget = 19; }
        else if (diff <= 0.20) { total += 13; breakdown.budget = 13; }
        else { total += 7; breakdown.budget = 7; }
        matchedOn.push('budget');
      }
    }

    // === Location Match (28 points) ===
    const locationScore = this._scoreLocation(params, project);
    if (locationScore > 0) {
      total += locationScore;
      breakdown.location = locationScore;
      matchedOn.push('location');
    }

    // === Property Type Match (18 points) ===
    // Mirrors MatchEngineV2._scorePropertyType: neutral small score when the
    // lead gives no type, graded score otherwise (handles mixed-use, plots,
    // related families). This is what previously made reverse matching notify
    // e.g. a plot buyer about a flat — now type relevance is factored in.
    const typeResult = propertyTypeNormalizer.matchScore(params.propertyType, project);
    if (typeResult.score === null) {
      total += 4;
      breakdown.propertyType = 4; // type_neutral
    } else {
      const points = Math.round(typeResult.score * 18);
      total += points;
      breakdown.propertyType = points;
      if (points > 0) matchedOn.push(`type_${typeResult.method}`);
    }

    // === BHK Match (14 points) — skipped for land/plot/mixed-use requirements ===
    const reqIsLand = params.propertyType && propertyTypeNormalizer.isLandType(params.propertyType);
    if (!reqIsLand && params.bhkType && project.configuration?.bhkOptions?.length) {
      const reqBhk = params.bhkType.toLowerCase().replace(/\s+/g, '');
      const bhkNum = parseInt(reqBhk);

      const exactMatch = project.configuration.bhkOptions.some(opt =>
        opt.toLowerCase().replace(/\s+/g, '').includes(reqBhk) ||
        opt.toLowerCase().includes(`${bhkNum}bhk`)
      );

      if (exactMatch) {
        total += 14;
        breakdown.bhk = 14;
        matchedOn.push('bhk');
      } else {
        // Adjacent BHK
        const adjacentMatch = project.configuration.bhkOptions.some(opt => {
          const optNum = parseInt(opt);
          return !isNaN(optNum) && Math.abs(optNum - bhkNum) === 1;
        });
        if (adjacentMatch) {
          total += 6;
          breakdown.bhk = 6;
          matchedOn.push('bhk_adjacent');
        }
      }
    }

    // === Loan Match (6 points) ===
    if (params.loanRequired && project.pricing?.bankLoanAvailable) {
      total += 6;
      breakdown.loan = 6;
      matchedOn.push('loan');
    } else if (!params.loanRequired) {
      total += 3;
      breakdown.loan = 3;
    }

    // === Possession Match (6 points) ===
    if (params.possessionNeeded && project.projectStatus) {
      const possessionMap = {
        'immediate': ['ready-to-move', 'completed', 'ready', 'possession-ready'],
        '6months': ['under-construction', 'nearing-completion', 'ready-to-move'],
        '1year': ['under-construction', 'pre-launch', 'nearing-completion'],
        '2year': ['under-construction', 'pre-launch', 'new-launch']
      };
      const validStatuses = possessionMap[params.possessionNeeded] || [];
      const projectStatus = project.projectStatus.toLowerCase().replace(/\s+/g, '-');
      if (validStatuses.some(s => projectStatus.includes(s))) {
        total += 6;
        breakdown.possession = 6;
        matchedOn.push('possession');
      }
    }

    // === Bonus: Verified Builder (3 points) ===
    const owner = project.owner;
    if (owner?.verificationStatus?.builder === 'verified') {
      total += 3;
      breakdown.verified = 3;
      matchedOn.push('verified_builder');
    }

    // === Bonus: RERA (2 points) ===
    if (project.reraApproved) {
      total += 2;
      breakdown.rera = 2;
      matchedOn.push('rera');
    }

    // === PENALTY: No location match when lead has a location ===
    // If the lead specifies a location but it doesn't match the project at all,
    // apply a penalty to prevent cross-city/cross-area false positives
    if ((params.location || params.locationRaw) && !matchedOn.includes('location')) {
      const penalty = 20;
      total = Math.max(0, total - penalty);
      breakdown.locationPenalty = -penalty;
    }

    return { total: Math.min(100, total), breakdown, matchedOn };
  }

  _scoreLocation(params, project) {
    const reqLocation = params.locationRaw || params.location;
    if (!reqLocation) return 0;

    const projectLocation = project.location || '';
    const projectCoords = (project.latitude && project.longitude)
      ? { lat: project.latitude, lng: project.longitude }
      : null;

    const result = locationNormalizer.isSameArea(
      reqLocation,
      projectLocation || project.city || '',
      projectCoords
    );

    if (!result.matches) return 0;

    // Kept in sync with MatchEngineV2._scoreLocation.
    switch (result.method) {
      case 'canonical_match': return 28;
      case 'geo_proximity_2km': return 26;
      case 'geo_proximity_5km': return 19;
      case 'substring_fallback': return 14;
      case 'trigram_similarity': return 11;
      default: return 9;
    }
  }

  // ─── Step 4.5: Auto-create / join project sub-groups ───────────────────────

  /**
   * For each matched agent, ensure a project sub-group exists and add the agent
   * to it — the same behaviour the forward path already provides. Non-blocking:
   * a sub-group failure for one agent never aborts the others or the publish.
   *
   * Only requirement-type leads get a sub-group (an inventory lead being matched
   * against new inventory shouldn't pull the poster into the seller's deal room),
   * mirroring the `intent !== 'inventory'` guard in LeadCaptureService.
   *
   * @param {Array} matches - validated reverse matches ({ lead, score, ... })
   * @param {object} project - the published project (owner populated)
   * @param {object} [io] - Socket.io instance
   */
  async _createSubGroupsForMatches(matches, project, io) {
    try {
      const { findOrCreateProjectSubGroup } = require('./UniversalGroupService');

      // De-duplicate by agent so each matched agent is added at most once, even
      // if they had multiple matching leads for this project.
      const seenAgents = new Set();

      for (const match of matches) {
        const lead = match.lead;
        if (!lead || !lead.extractedBy) continue;

        // Skip inventory leads — only buyers/requirements join the deal room.
        if (lead.intent === 'inventory') continue;

        const agentId = (lead.extractedBy._id || lead.extractedBy).toString();
        if (seenAgents.has(agentId)) continue;
        seenAgents.add(agentId);

        // Don't add the project owner to their own project sub-group.
        const ownerId = (project.owner?._id || project.owner)?.toString();
        if (ownerId && agentId === ownerId) continue;

        try {
          await findOrCreateProjectSubGroup(project, agentId, io);
        } catch (err) {
          logger.error('Reverse sub-group creation failed (non-blocking)', {
            error: err.message,
            projectId: project._id,
            agentId
          });
        }
      }
    } catch (err) {
      logger.error('Reverse sub-group step failed (non-blocking)', {
        error: err.message,
        projectId: project?._id
      });
    }
  }

  // ─── Step 4: Notify Agents ─────────────────────────────────────────────────

  async _notifyAgents(matches, project, io) {
    // Group matches by agent to avoid spamming the same agent multiple times
    const agentNotifications = new Map();

    for (const match of matches) {
      const agentId = match.lead.extractedBy._id.toString();
      if (!agentNotifications.has(agentId)) {
        agentNotifications.set(agentId, {
          agent: match.lead.extractedBy,
          matches: []
        });
      }
      agentNotifications.get(agentId).matches.push(match);
    }

    for (const [agentId, data] of agentNotifications) {
      const { agent, matches: agentMatches } = data;
      const bestScore = agentMatches[0].score;
      const leadSummary = agentMatches[0].lead.params;

      const title = `New inventory matches your requirement!`;
      const message = `"${project.projectName}" in ${project.location || project.city} matches your ${leadSummary.bhkType || ''} ${leadSummary.budget ? leadSummary.budget + 'L' : ''} requirement (${bestScore}% match)`;

      // Create DB notification
      await Notification.create({
        recipient: agentId,
        type: 'lead_match',
        title,
        message,
        reference: { model: 'Project', id: project._id }
      });

      // Real-time push via Socket.io
      if (io) {
        io.to(agentId).emit('reverse_match', {
          type: 'new_inventory_match',
          project: {
            _id: project._id,
            projectName: project.projectName,
            location: project.location,
            city: project.city,
            pricing: project.pricing,
            configuration: project.configuration,
            slug: project.slug,
            owner: project.owner
          },
          score: bestScore,
          matchedOn: agentMatches[0].matchedOn,
          leadId: agentMatches[0].lead._id,
          requirement: leadSummary
        });

        io.to(agentId).emit('notification', {
          type: 'lead_match',
          title,
          message,
          projectId: project._id
        });
      }
    }
  }

  // ─── Step 5: Notify Admins ─────────────────────────────────────────────────

  async _notifyAdmins(matches, project, io) {
    try {
      const admins = await User.find({ role: 'admin', isActive: true })
        .select('_id')
        .lean();

      if (admins.length === 0) return;

      const title = `Reverse match: "${project.projectName}" matches ${matches.length} lead${matches.length > 1 ? 's' : ''}`;
      const agentNames = [...new Set(matches.map(m => m.lead.extractedBy.name))].slice(0, 3);
      const message = `Agents: ${agentNames.join(', ')} | Top score: ${matches[0].score}% | ${project.location || project.city}`;

      const notifications = admins.map(admin => ({
        recipient: admin._id,
        type: 'lead_match',
        title,
        message,
        reference: { model: 'Project', id: project._id }
      }));

      await Notification.insertMany(notifications);

      if (io) {
        for (const admin of admins) {
          io.to(admin._id.toString()).emit('notification', {
            type: 'reverse_match',
            title,
            message,
            projectId: project._id,
            matchCount: matches.length,
            topScore: matches[0].score
          });
        }
      }
    } catch (err) {
      logger.error('Admin notification error (non-blocking)', { error: err.message });
    }
  }

  // ─── Step 6: Update Leads with Reverse Match ───────────────────────────────

  async _updateLeadsWithReverseMatch(matches, project) {
    try {
      // Idempotent per (lead, project): if this project is already recorded on
      // the lead (e.g. the project was published earlier and is now being
      // edited), refresh that match entry in place instead of pushing a
      // duplicate and inflating matchCount. Only brand-new (lead, project) pairs
      // increment matchCount. This makes repeated edits on a published project
      // safe to re-run without bloating the lead's match history.
      const projectId = project._id;

      const bulkOps = matches.map(match => {
        const existing = Array.isArray(match.lead.matches)
          ? match.lead.matches.some(m => m.project && m.project.toString() === projectId.toString())
          : false;

        if (existing) {
          // Update the existing array element for this project.
          return {
            updateOne: {
              filter: { _id: match.lead._id, 'matches.project': projectId },
              update: {
                $set: {
                  'matches.$.score': match.score,
                  'matches.$.confidence': match.score / 100,
                  'matches.$.matchedOn': match.matchedOn
                },
                $max: { bestMatchScore: match.score }
              }
            }
          };
        }

        // First time this lead sees this project — push + count.
        return {
          updateOne: {
            filter: { _id: match.lead._id },
            update: {
              $push: {
                matches: {
                  project: projectId,
                  score: match.score,
                  confidence: match.score / 100,
                  matchedOn: match.matchedOn
                }
              },
              $inc: { matchCount: 1 },
              $max: { bestMatchScore: match.score }
            }
          }
        };
      });

      if (bulkOps.length > 0) await ExtractedLead.bulkWrite(bulkOps);
    } catch (err) {
      logger.error('Failed to update leads with reverse match', { error: err.message });
    }
  }

  // ─── Public: Count live matching leads for one or more projects ─────────────

  /**
   * Count how many recent, live (non-expired) buyer leads match each project,
   * using the same scoring as the publish-time reverse match.
   *
   * This is a read-only, on-demand computation used to surface a "N buyers match
   * this" signal on project cards. It does not write anything or notify anyone.
   *
   * @param {string[]} projectIds - Project ObjectId strings to count matches for
   * @returns {Promise<Record<string, number>>} map of projectId -> match count
   */
  async countMatchesForProjects(projectIds) {
    const Project = require('../models/Project');

    const result = {};
    if (!Array.isArray(projectIds) || projectIds.length === 0) return result;

    // Load only the fields the scorer needs. Owner is populated for the
    // verified-builder bonus and to exclude the owner's own leads.
    const projects = await Project.find({ _id: { $in: projectIds } })
      .select('projectName city location latitude longitude projectStatus reraApproved owner pricing configuration')
      .populate('owner', 'verificationStatus')
      .lean();

    for (const project of projects) {
      const id = project._id.toString();
      try {
        const candidateLeads = await this._findCandidateLeads(project);
        if (candidateLeads.length === 0) {
          result[id] = 0;
          continue;
        }
        const scored = this._scoreLeadsAgainstProject(candidateLeads, project);
        result[id] = scored.filter(m => m.score >= MIN_REVERSE_SCORE).length;
      } catch (err) {
        // Never let one bad project break the whole batch — just report 0.
        logger.error('countMatchesForProjects: scoring failed for project', {
          projectId: id,
          error: err.message
        });
        result[id] = 0;
      }
    }

    // Ensure every requested id is present in the response (0 if not found).
    for (const rawId of projectIds) {
      const id = String(rawId);
      if (!(id in result)) result[id] = 0;
    }

    return result;
  }
}

module.exports = new ReverseMatchService();
