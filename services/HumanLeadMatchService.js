'use strict';

/**
 * HumanLeadMatchService
 *
 * Runs real property matching for a manually created + qualified CRM lead
 * (HumanLead), using the SAME engine and the SAME published Project data as the
 * rest of the platform. There is no separate CRM matching logic and no mock
 * data — this service only maps, calls MatchEngineV2, and records the result.
 *
 * TWO THINGS HERE ARE LOAD-BEARING
 *
 * 1. `allowNearest: false`
 *    MatchEngineV2 defaults to returning up to 3 "nearest" results whenever
 *    nothing clears the score threshold. Combined with the engine's free/neutral
 *    credit — measured at 14 points for a requirement specifying NOTHING
 *    (type_neutral 4 + loan 3 + possession 2 + verified_builder 3 + rera 2) —
 *    that means every verified RERA project looks like a partial match for every
 *    lead. Leaving the default on would make "no matching property found"
 *    impossible to ever reach, and would show agents properties that match
 *    nothing. So nearest-fallback is explicitly disabled: a match here means a
 *    match.
 *
 * 2. Every result goes through LeadPropertyMatch.recordMatch()
 *    That upsert is keyed on a unique (leadModel, lead, project) index, so this
 *    service is safe to run repeatedly — on qualification, on a manual rematch,
 *    and again every time a project is published. Re-runs refresh scores instead
 *    of creating duplicates, and only genuinely new pairs are reported back as
 *    `newPairs`, which is what a notification layer will consume.
 */

const mongoose = require('mongoose');
const HumanLead = require('../models/HumanLead');
const LeadPropertyMatch = require('../models/LeadPropertyMatch');
const matchEngineV2 = require('./MatchEngineV2');
const mapper = require('./LeadRequirementMapper');
const Logger = require('../utils/logger');

const logger = new Logger('HumanLeadMatch');

// Notification bar. 45 is the engine's own boundary between a "close" and a
// "nearest" match (MatchEngineV2._matchQuality), so this is the lowest score the
// engine itself is willing to call a real match. The chat path uses 25 and
// reverse matching uses 35; a CRM lead is curated by a human and shown to a
// client, so it is held to a stricter bar.
const MIN_MATCH_SCORE = 45;

// Cap per run. Agents act on the top few; more than this is noise.
const MAX_MATCHES = 10;

// Reasons matching did not run. Stored on the lead so the UI can explain itself
// instead of showing a bare empty state.
const SKIP_RENT = 'rent_not_supported';
const SKIP_INCOMPLETE = 'incomplete_requirements';

// Project fields needed to render a real property card. Mirrors what
// MatchEngineV2 selects so reads and writes agree on the shape.
const PROJECT_CARD_SELECT =
  'projectName slug city location propertyType category projectStatus ' +
  'pricing configuration media reraApproved reraNumber owner';

const PROJECT_OWNER_SELECT = 'name companyName role verificationStatus rating ratingCount';

class HumanLeadMatchService {

  /**
   * Match one qualified CRM lead against real published inventory.
   *
   * Never throws — matching is an enhancement to a stage change, not a
   * precondition for it, so a failure here must not fail the caller's request.
   *
   * @param {string|object} leadOrId - HumanLead document, lean object, or id
   * @param {object} [options]
   * @param {'qualification'|'project_published'|'manual_rematch'} [options.matchSource]
   * @param {number} [options.minScore]
   * @param {number} [options.limit]
   * @param {boolean} [options.persistSkipReason=true] - write skip reason to the lead
   * @returns {Promise<{
   *   ran: boolean,
   *   skippedReason: string|null,
   *   missing: string[],
   *   total: number,
   *   newCount: number,
   *   matches: Array<object>,
   *   newPairs: Array<object>,
   *   error: string|null
   * }>}
   */
  async matchQualifiedLead(leadOrId, options = {}) {
    const {
      matchSource = 'qualification',
      minScore = MIN_MATCH_SCORE,
      limit = MAX_MATCHES,
      persistSkipReason = true,
    } = options;

    const result = {
      ran: false,
      skippedReason: null,
      missing: [],
      total: 0,
      newCount: 0,
      matches: [],
      newPairs: [],
      error: null,
    };

    try {
      const lead = await this._loadLead(leadOrId);
      if (!lead) {
        result.error = 'lead_not_found';
        return result;
      }

      // ── Gate 1: rent is captured but not matchable ──
      // Project has no sale/rent distinction and MatchEngineV2 does not read
      // transactionType, so scoring a monthly rent against sale prices would
      // produce confident nonsense. Skip loudly rather than match wrongly.
      const { effective, missing } = mapper.isMatchable(lead);
      if (effective.transactionType === 'rent') {
        result.skippedReason = SKIP_RENT;
        if (persistSkipReason) await this._setSkipReason(lead._id, SKIP_RENT);
        logger.info('Skipped matching: rent lead', { leadId: String(lead._id) });
        return result;
      }

      // ── Gate 2: not enough information to match honestly ──
      if (missing.length > 0) {
        result.skippedReason = SKIP_INCOMPLETE;
        result.missing = missing;
        if (persistSkipReason) await this._setSkipReason(lead._id, SKIP_INCOMPLETE);
        logger.info('Skipped matching: incomplete requirements', {
          leadId: String(lead._id), missing,
        });
        return result;
      }

      // ── Run the real engine against real published projects ──
      const requirement = mapper.toRequirement(lead);
      const engineMatches = await matchEngineV2.findMatches(requirement, {
        limit,
        minScore,
        // THE critical option — see the file header.
        allowNearest: false,
        // Deliberately NOT excluding any owner. Unlike group chat (where you
        // must not be shown your own listing), an agent matching a client's
        // requirement against their own builder's stock is the desired outcome.
        excludeOwner: options.excludeOwner || undefined,
      });

      result.ran = true;

      // Defence in depth: even with allowNearest:false, never record something
      // the engine itself would not call a real match.
      const solid = (engineMatches || []).filter(
        (m) => m && m.project && m.score >= minScore && !m.nearest
      );

      if (solid.length === 0) {
        // A genuine "nothing matches yet". The lead stays matchingEnabled, so a
        // project published later will pick it up via ReverseMatchService.
        await this._touchRun(lead._id, { clearSkipReason: true });
        await this.refreshLeadMatchSummary(lead._id);
        logger.info('No matching properties for qualified lead', {
          leadId: String(lead._id),
          requirement: this._summarise(requirement),
        });
        return result;
      }

      // ── Record every pair idempotently ──
      const recorded = await this.recordMatches(lead._id, solid, matchSource);
      result.newPairs = recorded.newPairs;
      result.newCount = recorded.newPairs.length;

      result.matches = solid.map((m) => this.shapeMatch(m.project, {
        score: m.score,
        confidence: m.confidence,
        matchedOn: m.matchedOn,
        matchQuality: m.matchQuality,
      }));

      await this._touchRun(lead._id, { clearSkipReason: true });
      const summary = await this.refreshLeadMatchSummary(lead._id);
      result.total = summary.matchCount;

      logger.info('Qualified lead matched', {
        leadId: String(lead._id),
        found: solid.length,
        newPairs: result.newCount,
        totalLive: result.total,
        topScore: solid[0].score,
        matchSource,
      });

      return result;
    } catch (err) {
      // Matching must never break the caller (a stage change, a project publish).
      logger.error('matchQualifiedLead failed (non-blocking)', {
        error: err.message,
        stack: err.stack,
      });
      result.error = err.message;
      return result;
    }
  }

  /**
   * Persist a batch of engine matches for a lead, idempotently.
   *
   * Shared by the forward path (this service) and the reverse path
   * (ReverseMatchService), so both directions get the same dedupe guarantee and
   * write the same shape.
   *
   * @param {ObjectId|string} leadId
   * @param {Array<{project: object, score: number, confidence?: number, matchedOn?: string[], matchQuality?: string}>} matches
   * @param {string} matchSource
   * @param {string} [leadModel='HumanLead']
   * @returns {Promise<{ newPairs: Array<{matchId: any, projectId: any, score: number, project: object}>, existing: number }>}
   */
  async recordMatches(leadId, matches, matchSource = 'qualification', leadModel = 'HumanLead') {
    const newPairs = [];
    let existing = 0;

    for (const m of matches) {
      const projectId = m.project?._id || m.project;
      if (!projectId) continue;

      try {
        const { isNew } = await LeadPropertyMatch.recordMatch({
          lead: leadId,
          leadModel,
          project: projectId,
          score: m.score,
          confidence: m.confidence != null ? m.confidence : null,
          matchedOn: m.matchedOn || [],
          matchQuality: m.matchQuality === 'exact' ? 'exact' : 'close',
          matchSource,
        });

        if (isNew) {
          newPairs.push({
            projectId,
            score: m.score,
            matchedOn: m.matchedOn || [],
            project: m.project,
          });
        } else {
          existing++;
        }
      } catch (err) {
        // A single bad pair must not abort the batch.
        logger.error('recordMatches: failed for one pair', {
          leadId: String(leadId),
          projectId: String(projectId),
          error: err.message,
        });
      }
    }

    return { newPairs, existing };
  }

  /**
   * Recompute a lead's denormalised match summary FROM the join collection.
   *
   * Derived rather than incremented on purpose: matches arrive from two
   * independent paths (qualification and project-publish), and an incremented
   * counter drifts the first time either path partially fails or a match is
   * dismissed. The join collection is the source of truth.
   */
  async refreshLeadMatchSummary(leadId, leadModel = 'HumanLead') {
    const summary = { matchCount: 0, bestMatchScore: 0 };

    try {
      const [agg] = await LeadPropertyMatch.aggregate([
        { $match: { leadModel, lead: new mongoose.Types.ObjectId(String(leadId)), dismissed: false } },
        { $group: { _id: null, matchCount: { $sum: 1 }, bestMatchScore: { $max: '$score' } } },
      ]);

      summary.matchCount = agg?.matchCount || 0;
      summary.bestMatchScore = agg?.bestMatchScore || 0;

      if (leadModel === 'HumanLead') {
        await HumanLead.updateOne(
          { _id: leadId },
          { $set: { matchCount: summary.matchCount, bestMatchScore: summary.bestMatchScore } }
        );
      }
    } catch (err) {
      logger.error('refreshLeadMatchSummary failed', { leadId: String(leadId), error: err.message });
    }

    return summary;
  }

  /**
   * Read a lead's live matches, newest-strongest first, with real project data.
   * Backs GET /api/human-leads/:id/matches.
   */
  async getMatchesForLead(leadId, { includeDismissed = false, leadModel = 'HumanLead' } = {}) {
    const filter = { leadModel, lead: leadId };
    if (!includeDismissed) filter.dismissed = false;

    const rows = await LeadPropertyMatch.find(filter)
      .populate({
        path: 'project',
        select: PROJECT_CARD_SELECT,
        populate: { path: 'owner', select: PROJECT_OWNER_SELECT },
      })
      .sort({ score: -1, firstMatchedAt: -1 })
      .lean();

    return rows
      // A project can be deleted or unpublished after a match was recorded;
      // don't hand the client a half-empty card.
      .filter((row) => row.project)
      .map((row) => this.shapeMatch(row.project, {
        matchId: row._id,
        score: row.score,
        confidence: row.confidence,
        matchedOn: row.matchedOn,
        matchQuality: row.matchQuality,
        matchSource: row.matchSource,
        firstMatchedAt: row.firstMatchedAt,
        lastScoredAt: row.lastScoredAt,
        dismissed: row.dismissed,
      }));
  }

  /**
   * Flatten a project + its match metadata into the card the clients render.
   * Real data only — every field comes from the Project document.
   */
  shapeMatch(project, meta = {}) {
    const owner = project.owner || {};
    return {
      matchId: meta.matchId ? String(meta.matchId) : undefined,

      // Stable ID — this is the Lead → Property relationship the client uses.
      projectId: String(project._id),
      projectName: project.projectName || 'Project',
      slug: project.slug || '',
      city: project.city || '',
      location: project.location || '',
      propertyType: project.propertyType || project.category || '',
      projectStatus: project.projectStatus || '',

      startingPrice: project.pricing?.startingPrice || 0,
      bankLoanAvailable: !!project.pricing?.bankLoanAvailable,
      bhkOptions: project.configuration?.bhkOptions || [],
      carpetAreaRange: project.configuration?.carpetAreaRange || '',
      plotSizeRange: project.configuration?.plotSizeRange || '',

      coverImageUrl: project.media?.coverImage?.url || '',

      reraApproved: !!project.reraApproved,
      reraNumber: project.reraNumber || '',

      builderName: owner.name || '',
      builderCompany: owner.companyName || '',
      isVerifiedBuilder: owner.verificationStatus?.builder === 'verified',
      builderRating: owner.rating || 0,

      // Match metadata
      score: meta.score,
      confidence: meta.confidence != null ? meta.confidence : undefined,
      matchedOn: meta.matchedOn || [],
      matchQuality: meta.matchQuality,
      matchSource: meta.matchSource,
      firstMatchedAt: meta.firstMatchedAt,
      lastScoredAt: meta.lastScoredAt,
      dismissed: meta.dismissed,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  async _loadLead(leadOrId) {
    if (!leadOrId) return null;
    // Already a document/object carrying requirements.
    if (typeof leadOrId === 'object' && leadOrId._id && 'requirements' in leadOrId) {
      return leadOrId;
    }
    const id = typeof leadOrId === 'object' ? leadOrId._id : leadOrId;
    if (!mongoose.isValidObjectId(id)) return null;
    return HumanLead.findById(id).lean();
  }

  async _setSkipReason(leadId, reason) {
    try {
      await HumanLead.updateOne(
        { _id: leadId },
        { $set: { matchingSkippedReason: reason, lastMatchRunAt: new Date() } }
      );
    } catch (err) {
      logger.error('_setSkipReason failed', { leadId: String(leadId), error: err.message });
    }
  }

  async _touchRun(leadId, { clearSkipReason = false } = {}) {
    try {
      const update = { lastMatchRunAt: new Date() };
      if (clearSkipReason) update.matchingSkippedReason = null;
      await HumanLead.updateOne({ _id: leadId }, { $set: update });
    } catch (err) {
      logger.error('_touchRun failed', { leadId: String(leadId), error: err.message });
    }
  }

  _summarise(requirement) {
    return [
      requirement.bhkType,
      requirement.propertyType,
      requirement.budget != null ? `${requirement.budget}L` : null,
      requirement.locationRaw || requirement.city,
    ].filter(Boolean).join(' / ');
  }
}

module.exports = new HumanLeadMatchService();
module.exports.HumanLeadMatchService = HumanLeadMatchService;
module.exports.MIN_MATCH_SCORE = MIN_MATCH_SCORE;
module.exports.MAX_MATCHES = MAX_MATCHES;
module.exports.SKIP_RENT = SKIP_RENT;
module.exports.SKIP_INCOMPLETE = SKIP_INCOMPLETE;
module.exports.PROJECT_CARD_SELECT = PROJECT_CARD_SELECT;
