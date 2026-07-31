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
const Logger = require('../utils/logger');

const logger = new Logger('ReverseMatch');

// How far back to look for matching leads
const LOOKBACK_DAYS = 7;
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

    // Narrow by BHK if project has bhkOptions
    if (project.configuration?.bhkOptions?.length > 0) {
      const bhkNumbers = project.configuration.bhkOptions
        .map(opt => opt.match(/(\d)/))
        .filter(Boolean)
        .map(m => `${m[1]}BHK`);

      if (bhkNumbers.length > 0) {
        filter['params.bhkType'] = { $in: bhkNumbers };
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
   * Same logic as MatchEngineV2 but reversed: project is fixed, leads vary.
   */
  _calculateReverseScore(params, project) {
    const breakdown = {};
    const matchedOn = [];
    let total = 0;

    // === Budget Match (30 points) ===
    if (params.budget && project.pricing?.startingPrice) {
      const reqBudget = params.budget * 100000; // lakhs → value
      const reqBudgetMax = params.budgetMax ? params.budgetMax * 100000 : reqBudget * 1.1;
      const projPrice = project.pricing.startingPrice;

      // Check if project price falls within the lead's budget range
      const isInRange = projPrice >= (reqBudget * 0.8) && projPrice <= (reqBudgetMax * 1.2);
      if (isInRange) {
        const diff = Math.abs(reqBudget - projPrice) / reqBudget;
        if (diff <= 0.05) { total += 30; breakdown.budget = 30; }
        else if (diff <= 0.10) { total += 26; breakdown.budget = 26; }
        else if (diff <= 0.15) { total += 20; breakdown.budget = 20; }
        else if (diff <= 0.20) { total += 14; breakdown.budget = 14; }
        else { total += 8; breakdown.budget = 8; }
        matchedOn.push('budget');
      }
    }
    const locationScore = this._scoreLocation(params, project);
    if (locationScore > 0) {
      total += locationScore;
      breakdown.location = locationScore;
      matchedOn.push('location');
    }

    // === BHK Match (20 points) ===
    if (params.bhkType && project.configuration?.bhkOptions?.length) {
      const reqBhk = params.bhkType.toLowerCase().replace(/\s+/g, '');
      const bhkNum = parseInt(reqBhk);

      const exactMatch = project.configuration.bhkOptions.some(opt =>
        opt.toLowerCase().replace(/\s+/g, '').includes(reqBhk) ||
        opt.toLowerCase().includes(`${bhkNum}bhk`)
      );

      if (exactMatch) {
        total += 20;
        breakdown.bhk = 20;
        matchedOn.push('bhk');
      } else {
        // Adjacent BHK
        const adjacentMatch = project.configuration.bhkOptions.some(opt => {
          const optNum = parseInt(opt);
          return !isNaN(optNum) && Math.abs(optNum - bhkNum) === 1;
        });
        if (adjacentMatch) {
          total += 8;
          breakdown.bhk = 8;
          matchedOn.push('bhk_adjacent');
        }
      }
    }

    // === Loan Match (8 points) ===
    if (params.loanRequired && project.pricing?.bankLoanAvailable) {
      total += 8;
      breakdown.loan = 8;
      matchedOn.push('loan');
    } else if (!params.loanRequired) {
      total += 4;
      breakdown.loan = 4;
    }

    // === Possession Match (7 points) ===
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
        total += 7;
        breakdown.possession = 7;
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

    switch (result.method) {
      case 'canonical_match': return 30;
      case 'geo_proximity_2km': return 28;
      case 'geo_proximity_5km': return 20;
      case 'substring_fallback': return 15;
      case 'trigram_similarity': return 12;
      default: return 10;
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
      const bulkOps = matches.map(match => ({
        updateOne: {
          filter: { _id: match.lead._id },
          update: {
            $push: {
              matches: {
                project: project._id,
                score: match.score,
                confidence: match.score / 100,
                matchedOn: match.matchedOn
              }
            },
            $inc: { matchCount: 1 },
            $max: { bestMatchScore: match.score }
          }
        }
      }));

      await ExtractedLead.bulkWrite(bulkOps);
    } catch (err) {
      logger.error('Failed to update leads with reverse match', { error: err.message });
    }
  }
}

module.exports = new ReverseMatchService();
