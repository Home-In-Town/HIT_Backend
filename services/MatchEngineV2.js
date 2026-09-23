/**
 * MatchEngineV2
 * 
 * Enhanced matching engine that integrates LocationNormalizer for fuzzy location matching.
 * Replaces rigid substring matching with:
 *   - Alias-aware location resolution
 *   - Geo-proximity matching (lat/lng radius)
 *   - Wider budget bands at DB level (±20%) with gradient scoring
 *   - Smarter BHK parsing
 *   - Composite trust score
 * 
 * Backward compatible: still accepts requirement_card objects from the old flow,
 * AND accepts NLPExtractor output from free-text messages.
 */

const Project = require('../models/Project');
const User = require('../models/User'); // Required for populate('owner')
const locationNormalizer = require('./LocationNormalizer');
const propertyTypeNormalizer = require('./PropertyTypeNormalizer');
const fuzzyText = require('./FuzzyText');
const Logger = require('../utils/logger');
const logger = new Logger('MatchEngineV2');

class MatchEngineV2 {

  /**
   * Find matching projects for a requirement (from NLPExtractor or requirement_card).
   * 
   * @param {object} requirement - Extracted params
   * @param {string} requirement.bhkType - "2BHK", "3BHK", etc.
   * @param {number} requirement.budget - Budget in lakhs
   * @param {number} [requirement.budgetMax] - Max budget if range given
   * @param {string} requirement.location - Canonical location or raw text
   * @param {string} [requirement.locationRaw] - Original text before normalization
   * @param {string} [requirement.city] - City name
   * @param {string} [requirement.possessionNeeded] - Timeline
   * @param {boolean} [requirement.loanRequired] - Whether loan needed
   * @param {string} [requirement.propertyType] - flat, plot, villa, etc.
   * @param {object} options
   * @param {number} [options.limit=10] - Max results
   * @param {string} [options.excludeOwner] - Exclude projects by this user ID
   * @param {number} [options.minScore=25] - Minimum score threshold
   * @returns {Promise<Array<{project, score, matchedOn, confidence}>>}
   */
  async findMatches(requirement, options = {}) {
    const startTime = Date.now();
    const {
      limit = 10,
      excludeOwner,
      minScore = 25,
      // When nothing clears minScore, still return the closest few so the user
      // always sees *something* relevant instead of an empty result.
      allowNearest = true,
      nearestLimit = 3,
    } = options;

    const SELECT = 'projectName projectType category propertyType city location latitude longitude pricing configuration projectStatus owner media slug reraApproved reraNumber landmarks';

    try {
      // Progressive widening: start strict, then relax one constraint at a time.
      // A single over-constrained AND query was the reason one differing detail
      // (BHK / budget / exact locality) produced zero matches.
      const tiers = this._buildQueryTiers(requirement, excludeOwner);

      // Merge note: the incoming branch fetched candidates with ONE query. That
      // single over-constrained AND query is exactly what made one differing
      // detail return zero matches, so the tiered widening below is kept. The
      // extra fields their query selected (reraNumber, owner rating) are folded
      // into SELECT and the populate inside the loop so result cards stay rich.
      const seen = new Set();
      const candidates = [];
      let tiersUsed = 0;

      for (const query of tiers) {
        tiersUsed++;
        const batch = await Project.find(query)
          .populate('owner', 'name companyName role verificationStatus rating ratingCount')
          .select(SELECT)
          .limit(80)
          .lean();

        for (const p of batch) {
          const id = String(p._id);
          if (seen.has(id)) continue;
          seen.add(id);
          candidates.push(p);
        }

        // Stop as soon as this tier gives us enough solid matches.
        const solid = candidates
          .map((p) => this._calculateScore(requirement, p).score)
          .filter((sc) => sc >= minScore).length;
        if (solid >= limit) break;
        if (candidates.length >= 200) break; // safety cap
      }

      // Score every candidate we gathered.
      const scored = candidates.map((project) => {
        const result = this._calculateScore(requirement, project);
        return {
          project,
          score: result.score,
          matchedOn: result.matchedOn,
          confidence: result.confidence,
          breakdown: result.breakdown,
          matchQuality: this._matchQuality(result.score),
        };
      });

      scored.sort((a, b) => b.score - a.score);

      let topMatches = scored.filter((m) => m.score >= minScore).slice(0, limit);
      let usedNearest = false;

      // Nothing cleared the bar → hand back the closest options, clearly flagged.
      if (topMatches.length === 0 && allowNearest) {
        topMatches = scored
          .filter((m) => m.score > 0)
          .slice(0, nearestLimit)
          .map((m) => ({ ...m, matchQuality: 'nearest', nearest: true }));
        usedNearest = topMatches.length > 0;
      }

      const elapsed = Date.now() - startTime;
      logger.info(`MatchV2 completed in ${elapsed}ms`, {
        requirement: this._summarizeRequirement(requirement),
        tiersUsed,
        candidatesFound: candidates.length,
        matchesReturned: topMatches.length,
        nearestFallback: usedNearest,
        topScore: topMatches[0]?.score || 0
      });

      return topMatches;
    } catch (err) {
      logger.error('MatchEngineV2 error', { error: err.message, stack: err.stack });
      return [];
    }
  }

  /**
   * Label a score so the UI can tell the user how good the match really is.
   */
  _matchQuality(score) {
    if (score >= 70) return 'exact';
    if (score >= 45) return 'close';
    return 'nearest';
  }

  /**
   * Queries ordered strict → loose. Each tier drops/relaxes one constraint so a
   * single mismatched detail can't wipe out the candidate set.
   *
   *   0. Everything (budget ±20%, locality, BHK, loan)   — best case
   *   1. Budget widened to ±50%, BHK dropped              — "close on money"
   *   2. Locality dropped, city only                      — Koradi → any Nagpur
   *   3. Fully open (published only)                       — last resort
   */
  _buildQueryTiers(requirement, excludeOwner) {
    const tiers = [];

    // Tier 0 — strict (original behavior).
    tiers.push(this._buildQuery(requirement, excludeOwner));

    // Tier 1 — wider budget band, no BHK restriction.
    tiers.push(this._buildQuery(
      { ...requirement, bhkType: null },
      excludeOwner,
      { budgetTolerance: 0.5 }
    ));

    // Tier 2 — city only (keeps the search regional but forgets the locality).
    const cityOnly = { status: 'published' };
    if (excludeOwner) cityOnly.owner = { $ne: excludeOwner };
    if (requirement.city) {
      cityOnly.city = { $regex: this._escapeRegex(requirement.city), $options: 'i' };
      tiers.push(cityOnly);
    }

    // Tier 3 — anything published (ranked purely by score).
    const open = { status: 'published' };
    if (excludeOwner) open.owner = { $ne: excludeOwner };
    tiers.push(open);

    return tiers;
  }

  _escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ─── Query Builder ──────────────────────────────────────────────────────────

  _buildQuery(requirement, excludeOwner, opts = {}) {
    const { budgetTolerance = 0.2 } = opts;
    const query = { status: 'published' };

    // Exclude sender's own projects
    if (excludeOwner) {
      query.owner = { $ne: excludeOwner };
    }

    // Budget band at DB level; scoring narrows it further. Tolerance is widened
    // by later tiers so a near-miss budget still surfaces candidates.
    if (requirement.budget && requirement.budget > 0) {
      const budgetInUnits = requirement.budget * 100000; // lakhs → actual
      const maxBudget = requirement.budgetMax
        ? requirement.budgetMax * 100000 * (1 + budgetTolerance)
        : budgetInUnits * (1 + budgetTolerance);
      const minBudget = budgetInUnits * (1 - budgetTolerance);
      query['pricing.startingPrice'] = { $gte: minBudget, $lte: maxBudget };
    }

    // Location: use LocationNormalizer to build a smart regex
    const locationRegex = this._buildLocationQuery(requirement);
    if (locationRegex) {
      query.$or = [
        { location: locationRegex },
        { city: locationRegex }
      ];
    } else if (requirement.city) {
      query.city = { $regex: requirement.city, $options: 'i' };
    }

    // BHK: flexible match
    if (requirement.bhkType) {
      const bhkNum = requirement.bhkType.replace(/\D/g, '');
      if (bhkNum) {
        query['configuration.bhkOptions'] = {
          $regex: bhkNum + '\\s*BHK|' + bhkNum + 'BHK', $options: 'i'
        };
      }
    }

    // Loan filter (only restrict if explicitly required)
    if (requirement.loanRequired === true) {
      query['pricing.bankLoanAvailable'] = true;
    }

    // Property type: SOFT signal — we do NOT hard-exclude here, because a
    // project may express its type via projectType, category, OR the free-text
    // propertyType label. Hard-filtering on a single legacy field silently
    // drops valid matches (e.g. Mixed Use, "Commercial Plot / Land"). Scoring
    // handles type relevance instead (_scorePropertyType).
    //
    // We only apply a loose category-level narrowing to keep the candidate set
    // relevant when the requirement clearly targets one category — but we keep
    // legacy projects (no category field) in the net via $or.
    if (requirement.propertyType) {
      const norm = propertyTypeNormalizer.normalize(requirement.propertyType);
      if (norm.category && norm.category !== 'mixed_use') {
        const catRegex = norm.category === 'residential' ? /residential/i : /commercial/i;
        // Match projects in the same category OR projects with no category set
        // (legacy) OR mixed-use projects — scoring ranks them afterward.
        query.$and = (query.$and || []).concat([{
          $or: [
            { category: { $regex: catRegex } },
            { category: { $exists: false } },
            { category: null },
            { category: /mixed/i }
          ]
        }]);
      }
    }

    return query;
  }

  /**
   * Build a location regex that covers all known aliases of the detected location
   */
  _buildLocationQuery(requirement) {
    const rawLocation = requirement.locationRaw || requirement.location;
    if (!rawLocation) return null;

    // Use LocationNormalizer to build a comprehensive regex
    const regex = locationNormalizer.buildLocationRegex(rawLocation);
    return regex;
  }

  // ─── Scoring ────────────────────────────────────────────────────────────────

  /**
   * Calculate match score (0-100) with detailed breakdown
   */
  _calculateScore(requirement, project) {
    const breakdown = {};
    const matchedOn = [];
    let totalScore = 0;

    // NOTE on `matchedOn`: only genuine matches are listed. Graded "near"
    // fallbacks still contribute points (so nearest-match ranking works) but
    // must not claim the criterion was actually met.

    // === Budget Match (28 points max) ===
    const budgetScore = this._scoreBudget(requirement, project);
    breakdown.budget = budgetScore;
    totalScore += budgetScore.score;
    if (budgetScore.score > 0 && !budgetScore.near) matchedOn.push('budget');

    // === Location Match (28 points max) ===
    const locationScore = this._scoreLocation(requirement, project);
    breakdown.location = locationScore;
    totalScore += locationScore.score;
    if (locationScore.score > 0 && !locationScore.near) matchedOn.push(locationScore.method);

    // === Property Type Match (18 points max) ===
    const typeScore = this._scorePropertyType(requirement, project);
    breakdown.propertyType = typeScore;
    totalScore += typeScore.score;
    if (typeScore.score > 0) matchedOn.push(typeScore.method);

    // === BHK Match (14 points max) — skipped for land/plot types ===
    const isLand = requirement.propertyType && propertyTypeNormalizer.isLandType(requirement.propertyType);
    const bhkScore = isLand
      ? { score: 0, detail: 'land_no_bhk', skipped: true }
      : this._scoreBhk(requirement, project);
    breakdown.bhk = bhkScore;
    totalScore += bhkScore.score;
    if (bhkScore.score > 0 && !bhkScore.near) matchedOn.push('bhk');

    // === Area / Size Match (14 points max) ===
    // Compares a requirement's area (sqft-normalized) against the project's
    // plot/carpet size range. This is the primary discriminator for land, plot,
    // farm and commercial inventory — where BHK is meaningless. For those types
    // BHK scores 0, so area effectively takes BHK's slot; for BHK types it adds
    // a modest signal when an area is also stated.
    const areaScore = this._scoreArea(requirement, project);
    breakdown.area = areaScore;
    totalScore += areaScore.score;
    if (areaScore.score > 0) matchedOn.push('area');

    // === Loan Match (6 points max) ===
    const loanScore = this._scoreLoan(requirement, project);
    breakdown.loan = loanScore;
    totalScore += loanScore.score;
    if (loanScore.score > 0) matchedOn.push('loan');

    // === Possession Match (6 points max) ===
    const possessionScore = this._scorePossession(requirement, project);
    breakdown.possession = possessionScore;
    totalScore += possessionScore.score;
    if (possessionScore.score > 0 && !possessionScore.near) matchedOn.push('possession');

    // === Bonus: Verified Builder (3 points) ===
    if (project.owner?.verificationStatus?.builder === 'verified') {
      totalScore += 3;
      breakdown.verified = { score: 3 };
      matchedOn.push('verified_builder');
    }

    // === Bonus: RERA Approved (2 points) ===
    if (project.reraApproved) {
      totalScore += 2;
      breakdown.rera = { score: 2 };
      matchedOn.push('rera');
    }

    // Cap at 100
    const finalScore = Math.min(100, totalScore);

    // Confidence = composite of location confidence + param coverage
    const confidence = this._calculateConfidence(requirement, breakdown);

    return { score: finalScore, matchedOn, confidence, breakdown };
  }

  _scoreBudget(requirement, project) {
    if (!requirement.budget || !project.pricing?.startingPrice) {
      return { score: 0, detail: 'no_data' };
    }

    const reqBudget = requirement.budget * 100000; // lakhs → value
    const projPrice = project.pricing.startingPrice;
    const diff = Math.abs(reqBudget - projPrice) / reqBudget;

    if (diff <= 0.05) return { score: 28, detail: 'within_5%' };
    if (diff <= 0.10) return { score: 24, detail: 'within_10%' };
    if (diff <= 0.15) return { score: 19, detail: 'within_15%' };
    if (diff <= 0.20) return { score: 13, detail: 'within_20%' };
    if (diff <= 0.30) return { score: 7, detail: 'within_30%' };
    // Graded tail: a budget that's merely far off should still RANK (nearest
    // match) rather than score zero and disappear entirely.
    if (diff <= 0.50) return { score: 5, detail: 'within_50%', near: true };
    if (diff <= 1.00) return { score: 3, detail: 'within_100%', near: true };
    return { score: 1, detail: `diff_${Math.round(diff * 100)}%`, near: true };
  }

  /**
   * Score property-type relevance (0..18) using PropertyTypeNormalizer, which
   * understands legacy projectType, the category field, AND the rich free-text
   * propertyType labels from the upload form (incl. Mixed Use).
   *
   * When the requirement specifies no type, returns a small neutral score so
   * we neither reward nor punish (type just isn't a factor).
   */
  _scorePropertyType(requirement, project) {
    const reqType = requirement.propertyType;
    const result = propertyTypeNormalizer.matchScore(reqType, project);

    if (result.score === null) {
      // Requirement gave no type → neutral (don't skew ranking).
      return { score: 4, method: 'type_neutral' };
    }
    const points = Math.round(result.score * 18);
    return { score: points, method: `type_${result.method}`, raw: result.method };
  }

  _scoreLocation(requirement, project) {
    const rawLocation = requirement.locationRaw || requirement.location;
    if (!rawLocation) return { score: 0, method: 'no_location' };

    const projectLocation = project.location || '';
    const projectCity = project.city || '';
    const projectCoords = (project.latitude && project.longitude)
      ? { lat: project.latitude, lng: project.longitude }
      : null;

    // Use LocationNormalizer for smart comparison
    const locationMatch = locationNormalizer.isSameArea(
      rawLocation,
      projectLocation || projectCity,
      projectCoords
    );

    if (locationMatch.matches) {
      // Score based on confidence and method
      switch (locationMatch.method) {
        case 'canonical_match':
          return { score: 28, method: 'location_exact', confidence: locationMatch.confidence };
        case 'geo_proximity_2km':
          return { score: 26, method: 'location_2km', confidence: locationMatch.confidence };
        case 'geo_proximity_5km':
          return { score: 19, method: 'location_5km', confidence: locationMatch.confidence };
        case 'substring_fallback':
          return { score: 14, method: 'location_substring', confidence: locationMatch.confidence };
        case 'trigram_similarity':
          return { score: 11, method: 'location_fuzzy', confidence: locationMatch.confidence };
        default:
          return { score: 9, method: locationMatch.method, confidence: locationMatch.confidence };
      }
    }

    // Typo/spacing-tolerant locality compare, before falling back to city level.
    // LocationNormalizer only recognises localities present in its alias map, so
    // a misspelled or newly-seen locality used to drop straight to city scoring.
    // This catches "Manish Ngr" vs "Manish Nagar", "civillines" vs "Civil Lines",
    // reordered words and stray whitespace.
    if (projectLocation) {
      const fz = fuzzyText.compare(rawLocation, projectLocation);
      if (fz.score >= 0.95) {
        return { score: 27, method: 'location_fuzzy_exact', confidence: 0.9, fuzzy: fz.method };
      }
      if (fz.score >= 0.85) {
        return { score: 22, method: 'location_fuzzy_strong', confidence: 0.75, fuzzy: fz.method };
      }
      if (fz.score >= 0.7) {
        // A real but imperfect locality signal — graded, and flagged `near` so it
        // is never reported as an actual location match.
        return { score: 15, method: 'location_fuzzy_near', confidence: 0.55, fuzzy: fz.method, near: true };
      }
    }

    // City-level match as last resort — this is the "Koradi asked, Nagpur stock"
    // case: the locality differs but it's still the right city. Compared fuzzily
    // so "Ngpur"/"Nagpour" still resolve to Nagpur.
    if (requirement.city && projectCity) {
      const cityCmp = fuzzyText.compareCity(requirement.city, projectCity);
      if (cityCmp.score >= 0.9) {
        return { score: 8, method: 'city_only', confidence: 0.4 };
      }
      if (cityCmp.score >= 0.7) {
        return { score: 6, method: 'city_fuzzy', confidence: 0.3, near: true };
      }
      // Different city entirely → tiny score so it can still be offered as a
      // nearest match, but it can never outrank same-city stock (8 > 2).
      return { score: 2, method: 'other_city', confidence: 0.15, near: true };
    }

    return { score: 2, method: 'location_unknown', confidence: 0.1, near: true };
  }

  _scoreBhk(requirement, project) {
    if (!requirement.bhkType || !project.configuration?.bhkOptions?.length) {
      return { score: 0, detail: 'no_data' };
    }

    const reqBhk = requirement.bhkType.toLowerCase().replace(/\s+/g, '');
    const bhkNum = parseInt(reqBhk);

    for (const option of project.configuration.bhkOptions) {
      const optLower = option.toLowerCase().replace(/\s+/g, '');
      // Check if option contains the same BHK number
      if (optLower.includes(reqBhk) || optLower.includes(`${bhkNum}bhk`)) {
        return { score: 14, detail: 'exact_match' };
      }
    }

    // Graded BHK distance — a 4BHK hunter should still see 3BHK stock ranked
    // above nothing at all, just below the exact/adjacent options.
    let bestDelta = Infinity;
    for (const option of project.configuration.bhkOptions) {
      const optNum = parseInt(option);
      if (!isNaN(optNum)) bestDelta = Math.min(bestDelta, Math.abs(optNum - bhkNum));
    }
    if (bestDelta === 1) return { score: 6, detail: 'adjacent_bhk' };
    if (bestDelta === 2) return { score: 3, detail: 'bhk_off_by_2', near: true };
    if (Number.isFinite(bestDelta)) return { score: 1, detail: `bhk_off_by_${bestDelta}`, near: true };

    return { score: 0, detail: 'no_match' };
  }

  _scoreLoan(requirement, project) {
    if (requirement.loanRequired && project.pricing?.bankLoanAvailable) {
      return { score: 6, detail: 'loan_available' };
    }
    if (!requirement.loanRequired) {
      return { score: 3, detail: 'not_required' }; // Small bonus for not being restrictive
    }
    return { score: 0, detail: 'loan_not_available' };
  }

  _scorePossession(requirement, project) {
    if (!requirement.possessionNeeded || !project.projectStatus) {
      return { score: 2, detail: 'no_data_neutral' }; // Neutral score when no data
    }

    // Two vocabularies reach this function:
    //   • NLPExtractor (free text) → immediate | 6months | 1year | 2year
    //   • LeadFlowEngine (AI chat) → ready | under_construction
    // Both must be understood, otherwise chat-originated leads silently lose
    // their possession preference.
    const possessionMap = {
      // free-text vocabulary
      'immediate': ['ready-to-move', 'completed', 'ready', 'possession-ready'],
      '6months': ['under-construction', 'nearing-completion', 'pre-launch', 'ready-to-move'],
      '1year': ['under-construction', 'pre-launch', 'launch', 'nearing-completion'],
      '2year': ['under-construction', 'pre-launch', 'new-launch'],
      // AI-chat vocabulary
      'ready': ['ready-to-move', 'completed', 'ready', 'possession-ready'],
      'under_construction': ['under-construction', 'nearing-completion', 'pre-launch', 'launch', 'new-launch'],
    };

    const validStatuses = possessionMap[requirement.possessionNeeded] || [];
    const projectStatus = project.projectStatus.toLowerCase().replace(/\s+/g, '-');

    if (validStatuses.some(s => projectStatus.includes(s))) {
      return { score: 6, detail: 'status_match' };
    }
    // Wrong construction stage is a soft preference, not a disqualifier — keep
    // partial credit so it ranks below a status match but above nothing.
    return { score: 2, detail: 'status_mismatch', near: true };
  }

  /**
   * Score how well the requirement's area (sqft) fits the project's size range.
   * Returns up to 14 points. Neutral (0) when either side has no usable area.
   *
   * The project's size comes from plotSizeRange (land) or carpetAreaRange
   * (built-up), parsed into a [min,max] sqft window. Scoring:
   *   - requirement area inside the window            → 14  (in_range)
   *   - within 10% outside the window                 → 11  (near)
   *   - within 25% outside                            → 7   (loose)
   *   - otherwise                                     → 0   (mismatch)
   * If the project exposes only a single size (not a range), compare by percent
   * difference against that value with the same bands.
   */
  _scoreArea(requirement, project) {
    const reqArea = requirement.area;
    if (!reqArea || reqArea <= 0) return { score: 0, detail: 'no_req_area' };

    const range = MatchEngineV2.parseProjectArea(project);
    if (!range) return { score: 0, detail: 'no_proj_area' };

    const [min, max] = range;

    // Inside the project's advertised size window.
    if (reqArea >= min && reqArea <= max) {
      return { score: 14, detail: 'in_range', projRange: [min, max] };
    }

    // Outside — measure how far, relative to the nearest edge.
    const edge = reqArea < min ? min : max;
    const diff = Math.abs(reqArea - edge) / edge;
    if (diff <= 0.10) return { score: 11, detail: 'near', projRange: [min, max] };
    if (diff <= 0.25) return { score: 7, detail: 'loose', projRange: [min, max] };
    return { score: 0, detail: `diff_${Math.round(diff * 100)}%`, projRange: [min, max] };
  }

  /**
   * Parse a project's size into a [minSqft, maxSqft] range (sqft).
   * Prefers plotSizeRange (land), falls back to carpetAreaRange (built-up).
   *
   * Handles the messy real-world formats seen in the DB:
   *   "1200"                         → [1200, 1200]
   *   "1000-2000" / "1000 - 2000"    → [1000, 2000]
   *   "1060 TO 5952"                 → [1060, 5952]
   *   "861 sqft to 3659 sqft"        → [861, 3659]
   *   "1066, 1119, 1345, ..."        → [min, max] of the list
   *   "650-1200sq ft"                → [650, 1200]
   * Returns null when no numbers can be parsed.
   *
   * Static so both engines (forward + reverse) can share one implementation.
   */
  static parseProjectArea(project) {
    const raw = project?.configuration?.plotSizeRange || project?.configuration?.carpetAreaRange;
    if (!raw || typeof raw !== 'string') return null;

    // Pull every number (including decimals) out of the free-text string.
    const nums = (raw.match(/\d+(?:\.\d+)?/g) || [])
      .map(Number)
      .filter(n => !isNaN(n) && n > 0);

    if (nums.length === 0) return null;

    const min = Math.min(...nums);
    const max = Math.max(...nums);
    return [min, max];
  }

  /**
   * Calculate overall confidence in the match quality
   * Factors: location confidence, number of matching criteria, score distribution
   */
  _calculateConfidence(requirement, breakdown) {
    let confidence = 0;
    let factors = 0;

    // Location confidence is the strongest signal
    if (breakdown.location?.confidence) {
      confidence += breakdown.location.confidence * 0.4;
      factors++;
    }

    // Budget match
    if (breakdown.budget?.score >= 20) {
      confidence += 0.3;
      factors++;
    } else if (breakdown.budget?.score >= 10) {
      confidence += 0.15;
      factors++;
    }

    // BHK match
    if (breakdown.bhk?.score >= 10) {
      confidence += 0.15;
      factors++;
    }

    // Area/size match — the key discriminator for land/commercial inventory.
    if (breakdown.area?.score >= 11) {
      confidence += 0.15;
      factors++;
    } else if (breakdown.area?.score >= 7) {
      confidence += 0.08;
      factors++;
    }

    // Property type match (strong signal for correct inventory class)
    if (breakdown.propertyType?.score >= 14) {
      confidence += 0.15;
      factors++;
    } else if (breakdown.propertyType?.score >= 8) {
      confidence += 0.08;
      factors++;
    }

    // Multiple factors matching increases confidence
    if (factors >= 3) confidence += 0.1;

    return Math.min(1.0, confidence);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _summarizeRequirement(req) {
    const parts = [];
    if (req.bhkType) parts.push(req.bhkType);
    if (req.budget) parts.push(`${req.budget}L`);
    if (req.locationRaw || req.location) parts.push(req.locationRaw || req.location);
    if (req.propertyType) parts.push(req.propertyType);
    return parts.join(' | ') || 'empty';
  }
}

const matchEngineV2 = new MatchEngineV2();
// Expose the static area parser on the singleton export so other services
// (e.g. ReverseMatchService) can share one implementation of size parsing.
matchEngineV2.parseProjectArea = MatchEngineV2.parseProjectArea.bind(MatchEngineV2);
module.exports = matchEngineV2;
