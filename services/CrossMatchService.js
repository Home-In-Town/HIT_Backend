/**
 * CrossMatchService
 * 
 * Matches requirements against inventory (and vice versa) from chat messages.
 * 
 * When a new REQUIREMENT comes in:
 *   → Search recent inventory leads in the same room / all rooms
 *   → Score and return matches
 * 
 * When a new INVENTORY comes in:
 *   → Search recent requirement leads
 *   → Score and return matches
 *   → Notify admin of the cross-match
 * 
 * This is SEPARATE from MatchEngineV2 which matches against published Projects.
 * CrossMatch works lead-to-lead (chat message to chat message).
 */

const ExtractedLead = require('../models/ExtractedLead');
const Notification = require('../models/Notification');
const User = require('../models/User');
const locationNormalizer = require('./LocationNormalizer');
const Logger = require('../utils/logger');

const logger = new Logger('CrossMatch');

// How far back to look for matching leads
const LOOKBACK_DAYS = 7;
const MAX_RESULTS = 5;
const MIN_SCORE = 30;

class CrossMatchService {

  /**
   * When a new requirement is detected, find matching inventory leads.
   * 
   * @param {object} requirementLead - The newly created ExtractedLead (intent=requirement)
   * @param {object} [io] - Socket.io instance
   * @returns {Array} matched inventory leads with scores
   */
  async matchRequirementToInventory(requirementLead, io) {
    try {
      const lookback = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Find recent inventory leads
      const inventoryLeads = await ExtractedLead.find({
        intent: 'inventory',
        status: { $in: ['auto_detected', 'confirmed'] },
        createdAt: { $gte: lookback },
        extractedBy: { $ne: requirementLead.extractedBy } // Don't match own inventory
      })
        .populate('extractedBy', 'name role phone')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      if (inventoryLeads.length === 0) return [];

      // Score each inventory against the requirement
      const scored = inventoryLeads
        .map(inv => ({
          lead: inv,
          score: this._scoreCrossMatch(requirementLead.params, inv.params),
        }))
        .filter(m => m.score.total >= MIN_SCORE)
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, MAX_RESULTS);

      if (scored.length > 0) {
        // Update the requirement lead with cross-match info
        await this._updateLeadWithCrossMatches(requirementLead._id, scored, 'inventory');

        // Notify admin
        await this._notifyAdmin(requirementLead, scored, 'requirement_matched_inventory', io);

        logger.info('Requirement→Inventory cross-match found', {
          requirementId: requirementLead._id,
          matchCount: scored.length,
          topScore: scored[0].score.total
        });
      }

      return scored;
    } catch (err) {
      logger.error('matchRequirementToInventory error', { error: err.message });
      return [];
    }
  }

  /**
   * When a new inventory is detected, find matching requirement leads.
   * 
   * @param {object} inventoryLead - The newly created ExtractedLead (intent=inventory)
   * @param {object} [io] - Socket.io instance
   * @returns {Array} matched requirement leads with scores
   */
  async matchInventoryToRequirements(inventoryLead, io) {
    try {
      const lookback = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Find recent requirement leads
      const requirementLeads = await ExtractedLead.find({
        intent: { $in: ['requirement', 'implicit_requirement', 'follow_up_requirement'] },
        status: { $in: ['auto_detected', 'confirmed'] },
        createdAt: { $gte: lookback },
        extractedBy: { $ne: inventoryLead.extractedBy }
      })
        .populate('extractedBy', 'name role phone')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      if (requirementLeads.length === 0) return [];

      // Score each requirement against the inventory
      const scored = requirementLeads
        .map(req => ({
          lead: req,
          score: this._scoreCrossMatch(req.params, inventoryLead.params),
        }))
        .filter(m => m.score.total >= MIN_SCORE)
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, MAX_RESULTS);

      if (scored.length > 0) {
        // Update the inventory lead with cross-match info
        await this._updateLeadWithCrossMatches(inventoryLead._id, scored, 'requirement');

        // Notify admin
        await this._notifyAdmin(inventoryLead, scored, 'inventory_matched_requirements', io);

        logger.info('Inventory→Requirement cross-match found', {
          inventoryId: inventoryLead._id,
          matchCount: scored.length,
          topScore: scored[0].score.total
        });
      }

      return scored;
    } catch (err) {
      logger.error('matchInventoryToRequirements error', { error: err.message });
      return [];
    }
  }

  // ─── Scoring ────────────────────────────────────────────────────────────────

  /**
   * Score how well a requirement matches an inventory (or vice versa).
   * Both are ExtractedLead params objects.
   */
  _scoreCrossMatch(reqParams, invParams) {
    let total = 0;
    const matchedOn = [];

    // === Budget (30 pts) ===
    if (reqParams.budget && invParams.budget) {
      const reqBudget = reqParams.budget;
      const reqMax = reqParams.budgetMax || reqBudget * 1.1;
      const invBudget = invParams.budget;
      const invMax = invParams.budgetMax || invBudget;

      // Check overlap: does inventory price fall within requirement's range?
      const inRange = invBudget <= reqMax * 1.2 && invBudget >= reqBudget * 0.8;
      if (inRange) {
        const diff = Math.abs(reqBudget - invBudget) / reqBudget;
        if (diff <= 0.05) total += 30;
        else if (diff <= 0.10) total += 26;
        else if (diff <= 0.15) total += 20;
        else if (diff <= 0.20) total += 14;
        else total += 8;
        matchedOn.push('budget');
      }
    }

    // === Location (30 pts) ===
    if ((reqParams.location || reqParams.locationRaw) && (invParams.location || invParams.locationRaw)) {
      const reqLoc = reqParams.locationRaw || reqParams.location;
      const invLoc = invParams.locationRaw || invParams.location;

      const match = locationNormalizer.isSameArea(reqLoc, invLoc);
      if (match.matches) {
        switch (match.method) {
          case 'canonical_match': total += 30; break;
          case 'geo_proximity_2km': total += 28; break;
          case 'geo_proximity_5km': total += 20; break;
          case 'substring_fallback': total += 15; break;
          default: total += 10;
        }
        matchedOn.push('location');
      }
    }

    // === BHK (20 pts) ===
    if (reqParams.bhkType && invParams.bhkType) {
      const reqBhk = parseInt(reqParams.bhkType);
      const invBhk = parseInt(invParams.bhkType);
      if (reqBhk === invBhk) {
        total += 20;
        matchedOn.push('bhk');
      } else if (Math.abs(reqBhk - invBhk) === 1) {
        total += 8;
        matchedOn.push('bhk_adjacent');
      }
    }

    // === Property Type (10 pts) ===
    if (reqParams.propertyType && invParams.propertyType) {
      if (reqParams.propertyType === invParams.propertyType) {
        total += 10;
        matchedOn.push('property_type');
      }
    }

    // === Loan (5 pts) ===
    if (reqParams.loanRequired && invParams.loanRequired !== undefined) {
      total += 5;
      matchedOn.push('loan');
    }

    return { total: Math.min(100, total), matchedOn };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async _updateLeadWithCrossMatches(leadId, scored, matchType) {
    try {
      const crossMatches = scored.map(s => ({
        lead: s.lead._id,
        score: s.score.total,
        matchedOn: s.score.matchedOn,
        matchType // 'inventory' or 'requirement'
      }));

      await ExtractedLead.findByIdAndUpdate(leadId, {
        $set: {
          crossMatches,
          crossMatchCount: crossMatches.length,
          bestCrossMatchScore: scored[0].score.total
        }
      });
    } catch (err) {
      logger.error('_updateLeadWithCrossMatches error', { error: err.message });
    }
  }

  async _notifyAdmin(sourceLead, scored, type, io) {
    try {
      const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
      if (admins.length === 0) return;

      const sourceParams = sourceLead.params;
      const paramSummary = [
        sourceParams.bhkType,
        sourceParams.budget ? `${sourceParams.budget}L` : null,
        sourceParams.locationRaw || sourceParams.location,
        sourceParams.propertyType
      ].filter(Boolean).join(', ');

      const isInventory = type === 'inventory_matched_requirements';
      const title = isInventory
        ? `Inventory matches ${scored.length} requirement${scored.length > 1 ? 's' : ''}!`
        : `Requirement matches ${scored.length} inventor${scored.length > 1 ? 'ies' : 'y'}!`;
      const message = `${paramSummary} — Top match: ${scored[0].score.total}% (${scored[0].lead.extractedBy?.name || 'Unknown'})`;

      const notifications = admins.map(admin => ({
        recipient: admin._id,
        type: 'lead_match',
        title,
        message,
        reference: { model: 'ExtractedLead', id: sourceLead._id }
      }));

      await Notification.insertMany(notifications);

      if (io) {
        for (const admin of admins) {
          io.to(admin._id.toString()).emit('notification', {
            type: 'cross_match',
            title,
            message,
            leadId: sourceLead._id,
            matchCount: scored.length,
            topScore: scored[0].score.total
          });
        }
      }
    } catch (err) {
      logger.error('_notifyAdmin error', { error: err.message });
    }
  }
}

module.exports = new CrossMatchService();
