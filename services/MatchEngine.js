const Project = require('../models/Project');
const Logger = require('../utils/logger');

const logger = new Logger('MatchEngine');

/**
 * MatchEngine - AI Auto-Match Service
 * 
 * When an agent posts a requirement card (e.g., "2BHK 45L Manish Nagar urgent"),
 * this engine finds matching live inventory from published projects within 5 seconds.
 * 
 * Match Logic:
 * - Budget: ±10% of agent's stated budget
 * - Area/Location: same city or location (fuzzy match)
 * - BHK: matches project's bhkOptions
 * - Possession: matches project status
 * - Loan: if required, project must have bankLoanAvailable = true
 * - Builder rating: verified builders get bonus score
 */

class MatchEngine {

  /**
   * Find matching projects for an agent's requirement
   * @param {Object} requirement - The requirement card data
   * @param {string} requirement.bhkType - e.g., "2BHK"
   * @param {number} requirement.budget - Budget in lakhs
   * @param {string} requirement.area - Location/area name
   * @param {string} requirement.city - City name
   * @param {string} requirement.possessionNeeded - "immediate", "6months", "1year"
   * @param {boolean} requirement.loanRequired - Whether loan is needed
   * @param {Object} options - Additional options
   * @param {number} options.limit - Max results (default: 10)
   * @param {string} options.excludeOwner - Exclude projects by this owner ID
   * @returns {Array} Matched projects with scores
   */
  async findMatches(requirement, options = {}) {
    const startTime = Date.now();
    const { limit = 10, excludeOwner } = options;

    try {
      // Build the base query - only published projects
      const query = { status: 'published' };

      // Exclude the agent's own projects if specified
      if (excludeOwner) {
        query.owner = { $ne: excludeOwner };
      }

      // Area/City filter (broad match first, score refines later)
      if (requirement.city) {
        query.city = { $regex: requirement.city, $options: 'i' };
      }

      // BHK filter
      if (requirement.bhkType) {
        query['configuration.bhkOptions'] = {
          $regex: requirement.bhkType, $options: 'i'
        };
      }

      // Budget range filter: ±10%
      if (requirement.budget && requirement.budget > 0) {
        const budgetInUnits = requirement.budget * 100000; // Convert lakhs to actual value
        const minBudget = budgetInUnits * 0.9;
        const maxBudget = budgetInUnits * 1.1;
        query['pricing.startingPrice'] = { $gte: minBudget, $lte: maxBudget };
      }

      // Loan filter
      if (requirement.loanRequired) {
        query['pricing.bankLoanAvailable'] = true;
      }

      // Fetch candidate projects
      const projects = await Project.find(query)
        .populate('owner', 'name companyName role verificationStatus')
        .select('projectName projectType city location pricing configuration projectStatus owner media slug reraApproved')
        .limit(50) // Fetch more than needed for scoring
        .lean();

      // Score each project
      const scored = projects.map(project => {
        const { score, matchedOn } = this._calculateScore(requirement, project);
        return { project, score, matchedOn };
      });

      // Sort by score descending, take top results
      scored.sort((a, b) => b.score - a.score);
      const topMatches = scored.slice(0, limit).filter(m => m.score >= 30); // Min 30% match

      const elapsed = Date.now() - startTime;
      logger.info(`Match completed in ${elapsed}ms`, {
        requirement: `${requirement.bhkType} ${requirement.budget}L ${requirement.area}`,
        candidatesFound: projects.length,
        matchesReturned: topMatches.length
      });

      return topMatches;
    } catch (err) {
      logger.error('Match engine error', { error: err.message });
      return [];
    }
  }

  /**
   * Calculate match score for a project against a requirement
   * Score: 0-100
   */
  _calculateScore(requirement, project) {
    let score = 0;
    const matchedOn = [];
    const maxScore = 100;

    // === Budget Match (30 points) ===
    if (requirement.budget && project.pricing?.startingPrice) {
      const budgetInUnits = requirement.budget * 100000;
      const projectPrice = project.pricing.startingPrice;
      const diff = Math.abs(budgetInUnits - projectPrice) / budgetInUnits;

      if (diff <= 0.05) {
        score += 30; // Within 5% — perfect match
        matchedOn.push('budget');
      } else if (diff <= 0.10) {
        score += 25; // Within 10% — good match
        matchedOn.push('budget');
      } else if (diff <= 0.15) {
        score += 15; // Within 15% — acceptable
        matchedOn.push('budget_approx');
      }
    }

    // === Area/Location Match (25 points) ===
    if (requirement.area && project.location) {
      const reqArea = requirement.area.toLowerCase().trim();
      const projLocation = project.location.toLowerCase().trim();

      if (projLocation.includes(reqArea) || reqArea.includes(projLocation)) {
        score += 25;
        matchedOn.push('area');
      } else if (requirement.city && project.city) {
        // City-level match is weaker
        const reqCity = requirement.city.toLowerCase().trim();
        const projCity = project.city.toLowerCase().trim();
        if (projCity.includes(reqCity) || reqCity.includes(projCity)) {
          score += 10;
          matchedOn.push('city');
        }
      }
    }

    // === BHK Match (20 points) ===
    if (requirement.bhkType && project.configuration?.bhkOptions?.length) {
      const reqBhk = requirement.bhkType.toLowerCase();
      const hasBhk = project.configuration.bhkOptions.some(
        opt => opt.toLowerCase().includes(reqBhk)
      );
      if (hasBhk) {
        score += 20;
        matchedOn.push('bhk');
      }
    }

    // === Loan Available (10 points) ===
    if (requirement.loanRequired && project.pricing?.bankLoanAvailable) {
      score += 10;
      matchedOn.push('loan');
    } else if (!requirement.loanRequired) {
      // No loan needed — give partial score anyway
      score += 5;
    }

    // === Possession/Status Match (10 points) ===
    if (requirement.possessionNeeded) {
      const possessionMap = {
        'immediate': ['ready-to-move', 'completed', 'ready'],
        '6months': ['under-construction', 'nearing-completion', 'pre-launch'],
        '1year': ['under-construction', 'pre-launch', 'launch']
      };
      const validStatuses = possessionMap[requirement.possessionNeeded] || [];
      if (validStatuses.some(s => project.projectStatus?.toLowerCase().includes(s))) {
        score += 10;
        matchedOn.push('possession');
      }
    }

    // === Builder Rating Bonus (5 points) ===
    if (project.owner?.verificationStatus?.builder === 'verified') {
      score += 5;
      matchedOn.push('verified_builder');
    }

    // === RERA Approved Bonus (bonus) ===
    if (project.reraApproved) {
      score += 3;
      matchedOn.push('rera');
    }

    // Normalize: cap at 100
    const finalScore = Math.min(score, maxScore);

    return { score: finalScore, matchedOn };
  }
}

module.exports = new MatchEngine();
