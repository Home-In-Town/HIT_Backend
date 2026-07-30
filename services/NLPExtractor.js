/**
 * NLPExtractor
 * 
 * Extracts structured requirement parameters from free-text chat messages.
 * No external API calls — runs purely on regex + keyword detection in-process (< 10ms).
 * 
 * Detects:
 *   - Intent (is this a requirement/looking-for message?)
 *   - BHK type (1BHK, 2BHK, 3BHK, etc.)
 *   - Budget (60L, 60 lakh, 0.6cr, etc.)
 *   - Location (via LocationNormalizer)
 *   - Property type (flat, plot, villa, row house, etc.)
 *   - Possession timeline (immediate, ready, under construction, etc.)
 *   - Loan requirement
 *   - Urgency
 * 
 * Example:
 *   Input: "I am looking for a flat, 2bhk, 60lakh budget, near Manish nagar"
 *   Output: { intent: 'requirement', confidence: 0.9, params: { bhkType: '2BHK', budget: 60, ... } }
 */

const locationNormalizer = require('./LocationNormalizer');
const Logger = require('../utils/logger');
const logger = new Logger('NLPExtractor');

// ─── Intent Detection Keywords ──────────────────────────────────────────────
const REQUIREMENT_INTENT_PATTERNS = [
  /\b(looking\s+for|need|require|want|searching\s+for)\b/i,
  /\b(client\s+(needs?|wants?|looking|requires?))\b/i,
  /\b(buyer\s+(for|needs?|wants?))\b/i,
  /\b(requirement|demand)\b/i,
  /\b(koi\s+(flat|plot|villa|property))\b/i,  // Hindi-English mix
  /\b(chahiye|chaiye|mangta|dedo)\b/i,         // Hindi intent words
  /\b(anyone\s+has?|does\s+anyone\s+have)\b/i,
  /\b(can\s+someone\s+suggest|suggest\s+me)\b/i,
  /\b(interested\s+in\s+buying)\b/i,
  /\b(want\s+to\s+buy|wanna\s+buy)\b/i,
];

// Negative patterns — messages that should NOT be treated as requirements
const NEGATIVE_INTENT_PATTERNS = [
  /\b(good\s+morning|good\s+evening|good\s+night|hello|hi\s+everyone)\b/i,
  /\b(thank\s*you|thanks|congrats|congratulations)\b/i,
  /\b(happy\s+(birthday|diwali|holi|new\s+year))\b/i,
  /\b(sold|booked|deal\s+done|closed)\b/i,  // Not a requirement, it's a status update
  /\b(welcome|joined\s+the\s+group)\b/i,
];

// ─── BHK Extraction ─────────────────────────────────────────────────────────
const BHK_PATTERNS = [
  /(\d)\s*bhk/i,                           // "2bhk", "2 BHK", "3bhk"
  /(\d)\s*b\.?h\.?k\.?/i,                  // "2 B.H.K"
  /(one|two|three|four|five)\s*bhk/i,      // "two bhk"
  /(\d)\s*bedroom/i,                        // "2 bedroom"
  /(\d)\s*bed\b/i,                          // "2 bed flat"
  /(\d)\s*rk\b/i,                           // "1rk"
];

const WORD_TO_NUMBER = {
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'ek': 1, 'do': 2, 'teen': 3, 'chaar': 4, 'paanch': 5
};

// ─── Budget Extraction ──────────────────────────────────────────────────────
const BUDGET_PATTERNS = [
  // "60 lakh", "60lakh", "60 lac", "60L"
  /(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l)\b/i,
  // "1.2 crore", "1.2cr", "1.2 Cr"
  /(\d+(?:\.\d+)?)\s*(crore|crores|cr)\b/i,
  // "60,00,000" or "6000000" (Indian notation)
  /(?:budget|price|range)[:\s]*(?:rs\.?\s*)?(\d{1,3}(?:,?\d{2})*(?:,?\d{3}))/i,
  // "budget 60L", "budget: 60 lakh"
  /budget[:\s]*(?:rs\.?\s*)?(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|crore|crores|cr)/i,
  // Standalone large numbers that likely represent budget (50-500 followed by L context)
  /(\d{2,3})\s*(?:to|-)\s*(\d{2,3})\s*(lakh|lakhs|lac|lacs|l)/i,  // "50 to 60 lakh" range
];

// ─── Property Type ──────────────────────────────────────────────────────────
const PROPERTY_TYPES = {
  'flat': ['flat', 'flats', 'apartment', 'apartments', 'apt'],
  'plot': ['plot', 'plots', 'land', 'site'],
  'villa': ['villa', 'villas', 'bungalow', 'bungalows', 'bangla'],
  'row_house': ['row house', 'rowhouse', 'row-house', 'duplex', 'twin bungalow'],
  'penthouse': ['penthouse', 'pent house'],
  'shop': ['shop', 'shops', 'showroom', 'commercial'],
  'office': ['office', 'office space'],
};

// ─── Possession Timeline ────────────────────────────────────────────────────
const POSSESSION_PATTERNS = {
  'immediate': [/\b(immediate|ready\s*to\s*move|ready\s*possession|rtm|ready)\b/i],
  '6months': [/\b(6\s*month|six\s*month|within\s*6|possession\s*soon)\b/i],
  '1year': [/\b(1\s*year|one\s*year|under\s*construction|uc|ongoing)\b/i],
  '2year': [/\b(2\s*year|two\s*year|new\s*launch|pre[\s-]*launch)\b/i],
};

// ─── Loan Requirement ───────────────────────────────────────────────────────
const LOAN_PATTERNS = [
  /\b(loan|bank\s*loan|finance|emi|home\s*loan)\b/i,
  /\b(loan\s*(required|needed|chahiye|available))\b/i,
];

// ─── Urgency ────────────────────────────────────────────────────────────────
const URGENCY_PATTERNS = {
  'very_urgent': [/\b(very\s*urgent|asap|immediately|today|tomorrow|jaldi)\b/i],
  'urgent': [/\b(urgent|urgently|jald|quickly)\b/i],
  'normal': [] // default
};

// ─── Location Indicator Words (what comes after these is likely a location) ─
const LOCATION_INDICATORS = [
  'near', 'in', 'at', 'around', 'beside', 'behind', 'opposite',
  'close to', 'next to', 'area', 'locality', 'location'
];


class NLPExtractor {

  /**
   * Extract requirement parameters from a free-text message.
   * 
   * @param {string} text - Raw chat message text
   * @param {object} context - Optional context (sender role, room type, etc.)
   * @returns {{ intent: string, confidence: number, params: object } | null}
   */
  extract(text, context = {}) {
    if (!text || typeof text !== 'string' || text.trim().length < 5) {
      return null;
    }

    const cleanedText = text.trim();

    // Step 1: Check if this is NOT a requirement (negative intent)
    if (this._hasNegativeIntent(cleanedText)) {
      return null;
    }

    // Step 2: Detect requirement intent
    const intentResult = this._detectIntent(cleanedText);
    if (!intentResult.isRequirement) {
      // Even without explicit intent words, if we find ≥3 params, treat it as implicit requirement
      const params = this._extractAllParams(cleanedText);
      const paramCount = this._countValidParams(params);

      if (paramCount >= 3) {
        return {
          intent: 'implicit_requirement',
          confidence: Math.min(0.7, 0.3 + (paramCount * 0.15)),
          params,
          extractedFrom: cleanedText
        };
      }
      return null;
    }

    // Step 3: Extract all parameters
    const params = this._extractAllParams(cleanedText);
    const paramCount = this._countValidParams(params);

    // Need at least 1 param beyond just intent to be useful
    if (paramCount < 1) {
      return null;
    }

    // Confidence based on intent strength + param count
    const confidence = Math.min(0.95, intentResult.confidence + (paramCount * 0.1));

    return {
      intent: 'requirement',
      confidence,
      params,
      extractedFrom: cleanedText
    };
  }

  /**
   * Quick check: does this message contain any requirement signal?
   * Cheaper than full extraction — use for filtering.
   */
  hasRequirementSignal(text) {
    if (!text || text.length < 8) return false;
    const hasIntent = REQUIREMENT_INTENT_PATTERNS.some(p => p.test(text));
    const hasBhk = BHK_PATTERNS.some(p => p.test(text));
    const hasBudget = BUDGET_PATTERNS.some(p => p.test(text));
    return hasIntent || (hasBhk && hasBudget);
  }

  // ─── Private: Intent Detection ──────────────────────────────────────────────

  _detectIntent(text) {
    let maxConfidence = 0;

    for (const pattern of REQUIREMENT_INTENT_PATTERNS) {
      if (pattern.test(text)) {
        // Different patterns have different confidence levels
        const confidence = text.match(/\b(looking\s+for|need|require|want)\b/i) ? 0.6 :
                          text.match(/\b(client\s+(needs?|wants?))\b/i) ? 0.75 :
                          0.5;
        maxConfidence = Math.max(maxConfidence, confidence);
      }
    }

    return {
      isRequirement: maxConfidence > 0,
      confidence: maxConfidence
    };
  }

  _hasNegativeIntent(text) {
    return NEGATIVE_INTENT_PATTERNS.some(p => p.test(text));
  }

  // ─── Private: Parameter Extraction ──────────────────────────────────────────

  _extractAllParams(text) {
    return {
      bhkType: this._extractBhk(text),
      budget: this._extractBudget(text),
      budgetMax: this._extractBudgetRange(text),
      location: this._extractLocation(text),
      locationRaw: this._extractLocationRaw(text),
      locationCanonical: null, // filled by LocationNormalizer
      locationConfidence: 0,
      propertyType: this._extractPropertyType(text),
      possessionNeeded: this._extractPossession(text),
      loanRequired: this._extractLoan(text),
      urgency: this._extractUrgency(text),
      city: this._extractCity(text),
    };
  }

  _extractBhk(text) {
    for (const pattern of BHK_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        let num = match[1];
        // Convert word to number if needed
        if (WORD_TO_NUMBER[num.toLowerCase()]) {
          num = WORD_TO_NUMBER[num.toLowerCase()];
        }
        const bhkNum = parseInt(num);
        if (bhkNum >= 1 && bhkNum <= 6) {
          // Special case: 1RK
          if (/rk/i.test(match[0])) {
            return '1RK';
          }
          return `${bhkNum}BHK`;
        }
      }
    }
    return null;
  }

  _extractBudget(text) {
    // Try specific budget patterns
    for (const pattern of BUDGET_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = (match[2] || '').toLowerCase();

        if (unit.startsWith('cr')) {
          return value * 100; // Convert crore to lakhs
        }
        if (unit.startsWith('l') || unit.startsWith('lac')) {
          return value;
        }
        // Large raw number — try to interpret
        if (value > 100000) {
          return value / 100000; // Convert to lakhs
        }
      }
    }

    // Fallback: look for standalone numbers near budget indicators
    const budgetContext = text.match(/(\d+(?:\.\d+)?)\s*(l|lk|lakh|lac|cr|crore)\b/i);
    if (budgetContext) {
      const value = parseFloat(budgetContext[1]);
      const unit = budgetContext[2].toLowerCase();
      if (unit.startsWith('cr')) return value * 100;
      return value;
    }

    return null;
  }

  _extractBudgetRange(text) {
    // "50 to 60 lakh" or "50-60L"
    const rangeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|crore|crores|cr)/i);
    if (rangeMatch) {
      const maxValue = parseFloat(rangeMatch[2]);
      const unit = rangeMatch[3].toLowerCase();
      if (unit.startsWith('cr')) return maxValue * 100;
      return maxValue;
    }
    return null;
  }

  _extractLocation(text) {
    const rawLocation = this._extractLocationRaw(text);
    if (!rawLocation) return null;

    const normalized = locationNormalizer.normalize(rawLocation);
    // Store canonical and confidence on the params object
    // (we return just the canonical here, confidence is set separately)
    return normalized.canonical || normalized.originalCleaned;
  }

  _extractLocationRaw(text) {
    const lowerText = text.toLowerCase();

    // Strategy 1: Find text after location indicator words
    for (const indicator of LOCATION_INDICATORS) {
      const idx = lowerText.indexOf(indicator);
      if (idx !== -1) {
        // Extract the next 2-4 words after the indicator
        const afterIndicator = text.substring(idx + indicator.length).trim();
        const locationCandidate = this._extractLocationPhrase(afterIndicator);
        if (locationCandidate && locationCandidate.length >= 3) {
          return locationCandidate;
        }
      }
    }

    // Strategy 2: Check if any known location name appears in the text
    const knownMatch = locationNormalizer.normalize(lowerText);
    if (knownMatch.canonical && knownMatch.confidence >= 0.6) {
      // Find the actual text that matched
      return knownMatch.originalCleaned;
    }

    // Strategy 3: Look for capitalized multi-word phrases (likely place names)
    const capitalizedPhrases = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
    if (capitalizedPhrases) {
      for (const phrase of capitalizedPhrases) {
        const norm = locationNormalizer.normalize(phrase);
        if (norm.canonical) {
          return phrase;
        }
      }
    }

    return null;
  }

  /**
   * Extract a location phrase from text (2-4 words, stop at known delimiters)
   */
  _extractLocationPhrase(text) {
    // Remove budget/bhk patterns from the candidate
    let cleaned = text
      .replace(/\d+\s*(bhk|lakh|lakhs|lac|l|cr|crore|budget)/gi, '')
      .replace(/[,.].*$/, '') // Stop at comma or period
      .trim();

    // Take first 4 words max
    const words = cleaned.split(/\s+/).slice(0, 4);

    // Stop at known non-location words
    const stopWords = ['budget', 'price', 'bhk', 'flat', 'plot', 'villa', 'loan', 'urgent', 'ready', 'immediate'];
    const locationWords = [];
    for (const word of words) {
      if (stopWords.includes(word.toLowerCase())) break;
      if (/^\d+$/.test(word)) break; // Pure numbers
      locationWords.push(word);
    }

    return locationWords.join(' ').trim();
  }

  _extractPropertyType(text) {
    const lowerText = text.toLowerCase();
    for (const [type, keywords] of Object.entries(PROPERTY_TYPES)) {
      for (const keyword of keywords) {
        if (lowerText.includes(keyword)) {
          return type;
        }
      }
    }
    return null;
  }

  _extractPossession(text) {
    for (const [timeline, patterns] of Object.entries(POSSESSION_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return timeline;
        }
      }
    }
    return null;
  }

  _extractLoan(text) {
    return LOAN_PATTERNS.some(p => p.test(text));
  }

  _extractUrgency(text) {
    for (const [level, patterns] of Object.entries(URGENCY_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return level;
        }
      }
    }
    return 'normal';
  }

  _extractCity(text) {
    // Common cities in the system
    const cities = [
      'nagpur', 'mumbai', 'pune', 'nashik', 'aurangabad',
      'hyderabad', 'bangalore', 'delhi', 'noida', 'gurgaon',
      'thane', 'navi mumbai', 'indore', 'bhopal', 'jaipur',
      'chandigarh', 'kolkata', 'chennai', 'ahmedabad', 'surat'
    ];

    const lowerText = text.toLowerCase();
    for (const city of cities) {
      if (lowerText.includes(city)) {
        return city.charAt(0).toUpperCase() + city.slice(1);
      }
    }
    return null;
  }

  /**
   * Count how many meaningful params were extracted
   */
  _countValidParams(params) {
    let count = 0;
    if (params.bhkType) count++;
    if (params.budget) count++;
    if (params.location) count++;
    if (params.propertyType) count++;
    if (params.possessionNeeded) count++;
    if (params.loanRequired) count++;
    if (params.city) count++;
    if (params.urgency && params.urgency !== 'normal') count++;
    return count;
  }
}

module.exports = new NLPExtractor();
