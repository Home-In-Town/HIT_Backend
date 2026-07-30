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
const locationNormalizer = require('./LocationNormalizer');
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
    const { limit = 10, excludeOwner, minScore = 25 } = options;

    try {
      // Build the MongoDB query
      const query = this._buildQuery(requirement, excludeOwner);

      // Fetch candidate projects (wider net than final results)
      const projects = await Project.find(query)
        .populate('owner', 'name companyName role verificationStatus')
        .select('projectName projectType city location latitude longitude pricing configuration projectStatus owner media slug reraApproved landmarks')
        .limit(80) // Fetch more candidates for better scoring
        .lean();

      // Score each project
      const scored = projects.map(project => {
        const result = this._calculateScore(requirement, project);
        return {
          project,
          score: result.score,
          matchedOn: result.matchedOn,
          confidence: result.confidence,
          breakdown: result.breakdown
        };
      });

      // Sort by score descending, filter by minimum
      scored.sort((a, b) => b.score - a.score);
      const topMatches = scored
        .filter(m => m.score >= minScore)
        .slice(0, limit);

      const elapsed = Date.now() - startTime;
      logger.info(`MatchV2 completed in ${elapsed}ms`, {
        requirement: this._summarizeRequirement(requirement),
        candidatesFound: projects.length,
        matchesReturned: topMatches.length,
        topScore: topMatches[0]?.score || 0
      });

      return topMatches;
    } catch (err) {
      logger.error('MatchEngineV2 error', { error: err.message, stack: err.stack });
      return [];
    }
  }

  // ─── Query Builder ──────────────────────────────────────────────────────────

  _buildQuery(requirement, excludeOwner) {
    const query = { status: 'published' };

    // Exclude sender's own projects
    if (excludeOwner) {
      query.owner = { $ne: excludeOwner };
    }

    // Budget: ±20% at DB level (wider than old ±10%, scoring narrows it)
    if (requirement.budget && requirement.budget > 0) {
      const budgetInUnits = requirement.budget * 100000; // lakhs → actual
      const maxBudget = requirement.budgetMax
        ? requirement.budgetMax * 100000 * 1.2
        : budgetInUnits * 1.2;
      const minBudget = budgetInUnits * 0.8;
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

    // Property type filter
    if (requirement.propertyType) {
      const typeMap = {
        'flat': 'flat',
        'plot': 'plot',
        'villa': 'villa',
        'row_house': 'row house',
        'penthouse': 'penthouse',
        'shop': 'commercial',
        'office': 'commercial'
      };
      const mappedType = typeMap[requirement.propertyType];
      if (mappedType) {
        query.projectType = { $regex: mappedType, $options: 'i' };
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

    // === Budget Match (30 points max) ===
    const budgetScore = this._scoreBudget(requirement, project);
    breakdown.budget = budgetScore;
    totalScore += budgetScore.score;
    if (budgetScore.score > 0) matchedOn.push('budget');

    // === Location Match (30 points max — upgraded from 25) ===
    const locationScore = this._scoreLocation(requirement, project);
    breakdown.location = locationScore;
    totalScore += locationScore.score;
    if (locationScore.score > 0) matchedOn.push(locationScore.method);

    // === BHK Match (20 points max) ===
    const bhkScore = this._scoreBhk(requirement, project);
    breakdown.bhk = bhkScore;
    totalScore += bhkScore.score;
    if (bhkScore.score > 0) matchedOn.push('bhk');

    // === Loan Match (8 points max) ===
    const loanScore = this._scoreLoan(requirement, project);
    breakdown.loan = loanScore;
    totalScore += loanScore.score;
    if (loanScore.score > 0) matchedOn.push('loan');

    // === Possession Match (7 points max) ===
    const possessionScore = this._scorePossession(requirement, project);
    breakdown.possession = possessionScore;
    totalScore += possessionScore.score;
    if (possessionScore.score > 0) matchedOn.push('possession');

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

    if (diff <= 0.05) return { score: 30, detail: 'within_5%' };
    if (diff <= 0.10) return { score: 26, detail: 'within_10%' };
    if (diff <= 0.15) return { score: 20, detail: 'within_15%' };
    if (diff <= 0.20) return { score: 14, detail: 'within_20%' };
    if (diff <= 0.30) return { score: 8, detail: 'within_30%' };
    return { score: 0, detail: `diff_${Math.round(diff * 100)}%` };
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
          return { score: 30, method: 'location_exact', confidence: locationMatch.confidence };
        case 'geo_proximity_2km':
          return { score: 28, method: 'location_2km', confidence: locationMatch.confidence };
        case 'geo_proximity_5km':
          return { score: 20, method: 'location_5km', confidence: locationMatch.confidence };
        case 'substring_fallback':
          return { score: 15, method: 'location_substring', confidence: locationMatch.confidence };
        case 'trigram_similarity':
          return { score: 12, method: 'location_fuzzy', confidence: locationMatch.confidence };
        default:
          return { score: 10, method: locationMatch.method, confidence: locationMatch.confidence };
      }
    }

    // City-level match as last resort
    if (requirement.city && projectCity) {
      const reqCity = requirement.city.toLowerCase();
      const projCity = projectCity.toLowerCase();
      if (projCity.includes(reqCity) || reqCity.includes(projCity)) {
        return { score: 8, method: 'city_only', confidence: 0.4 };
      }
    }

    return { score: 0, method: 'no_match' };
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
        return { score: 20, detail: 'exact_match' };
      }
    }

    // Adjacent BHK (e.g., looking for 2BHK but project has 2.5BHK or 3BHK)
    for (const option of project.configuration.bhkOptions) {
      const optNum = parseInt(option);
      if (!isNaN(optNum) && Math.abs(optNum - bhkNum) === 1) {
        return { score: 8, detail: 'adjacent_bhk' };
      }
    }

    return { score: 0, detail: 'no_match' };
  }

  _scoreLoan(requirement, project) {
    if (requirement.loanRequired && project.pricing?.bankLoanAvailable) {
      return { score: 8, detail: 'loan_available' };
    }
    if (!requirement.loanRequired) {
      return { score: 4, detail: 'not_required' }; // Small bonus for not being restrictive
    }
    return { score: 0, detail: 'loan_not_available' };
  }

  _scorePossession(requirement, project) {
    if (!requirement.possessionNeeded || !project.projectStatus) {
      return { score: 3, detail: 'no_data_neutral' }; // Neutral score when no data
    }

    const possessionMap = {
      'immediate': ['ready-to-move', 'completed', 'ready', 'possession-ready'],
      '6months': ['under-construction', 'nearing-completion', 'pre-launch', 'ready-to-move'],
      '1year': ['under-construction', 'pre-launch', 'launch', 'nearing-completion'],
      '2year': ['under-construction', 'pre-launch', 'new-launch']
    };

    const validStatuses = possessionMap[requirement.possessionNeeded] || [];
    const projectStatus = project.projectStatus.toLowerCase().replace(/\s+/g, '-');

    if (validStatuses.some(s => projectStatus.includes(s))) {
      return { score: 7, detail: 'status_match' };
    }
    return { score: 0, detail: 'status_mismatch' };
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
    if (breakdown.bhk?.score >= 15) {
      confidence += 0.2;
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

module.exports = new MatchEngineV2();
