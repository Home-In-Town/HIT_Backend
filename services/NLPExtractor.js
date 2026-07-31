/**
 * NLPExtractor v2
 * 
 * Advanced NLP extraction from free-text chat messages.
 * Supports: English, Hindi (Romanized), Marathi (Romanized), mixed-language
 * 
 * Features:
 *   - Multi-language intent detection (English + Hindi + Marathi)
 *   - Multi-requirement parsing ("need 2bhk manish nagar AND 3bhk besa")
 *   - Budget ranges, approximate budgets, flexible/negotiable markers
 *   - Multi-location detection ("manish nagar or wardha road")
 *   - Message deduplication (prevents same requirement extracted twice)
 *   - Confidence calibration based on param combinations
 *   - Conversation context support (follow-up references)
 * 
 * No external API calls — runs in-process (< 15ms per message)
 */

const locationNormalizer = require('./LocationNormalizer');
const Logger = require('../utils/logger');
const logger = new Logger('NLPExtractor');

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT DETECTION — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const REQUIREMENT_INTENT_PATTERNS = [
  // English
  /\b(looking\s+for|need|require|want|searching\s+for)\b/i,
  /\b(client\s+(needs?|wants?|looking|requires?|ka\s+requirement))\b/i,
  /\b(buyer\s+(for|needs?|wants?))\b/i,
  /\b(requirement|demand)\b/i,
  /\b(anyone\s+has?|does\s+anyone\s+have|kisi\s+ke\s+paas)\b/i,
  /\b(can\s+someone\s+suggest|suggest\s+me)\b/i,
  /\b(interested\s+in\s+buying|want\s+to\s+buy|wanna\s+buy)\b/i,
  // Hindi (Romanized)
  /\b(chahiye|chaiye|chahie|chhaiye)\b/i,
  /\b(mangta|mangt[ai])\b/i,
  /\b(dhundh?\s*raha|dhundh?\s*rahi|dhundh?\s*rahe)\b/i,
  /\b(dedo|de\s*do|dila\s*do|dilwa\s*do)\b/i,
  /\b(koi\s+(flat|plot|villa|property|ghar|makan|makaan))\b/i,
  /\b(ghar\s+chahiye|makan\s+chahiye|makaan\s+chahiye)\b/i,
  /\b(lena\s+hai|leni\s+hai|kharidna\s+hai|khareedna)\b/i,
  /\b(dekhna\s+hai|dikhao|dikhado|batao)\b/i,
  // Marathi (Romanized)
  /\b(pahije|pahje|pahige)\b/i,
  /\b(havay|havy|hava\s+aahe|havi\s+aahe)\b/i,
  /\b(ghar\s+pahije|flat\s+pahije)\b/i,
  /\b(shodhat?\s+aahe|shodhtoy|shodhte)\b/i,
  /\b(ghyaycha|ghyaychi|vikta?\s+ka)\b/i,
];

// Negative patterns — messages that should NOT be treated as requirements
const NEGATIVE_INTENT_PATTERNS = [
  /\b(good\s+morning|good\s+evening|good\s+night|hello|hi\s+everyone)\b/i,
  /\b(thank\s*you|thanks|congrats|congratulations|badhai)\b/i,
  /\b(happy\s+(birthday|diwali|holi|new\s+year))\b/i,
  /\b(sold|booked|deal\s+done|closed|ho\s*gaya|bik\s*gaya)\b/i,
  /\b(welcome|joined\s+the\s+group)\b/i,
  /\b(suprabhat|shubh\s+prabhat|namaste\s*$)\b/i,
  /\b(jai\s+shree?\s+(ram|krishna|ganesh))\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// BHK EXTRACTION — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const BHK_PATTERNS = [
  /(\d)\s*bhk/i,
  /(\d)\s*b\.?h\.?k\.?/i,
  /(one|two|three|four|five)\s*bhk/i,
  /(\d)\s*bedroom/i,
  /(\d)\s*bed\b/i,
  /(\d)\s*rk\b/i,
  // Hindi variations
  /(ek|do|teen|chaar|paanch|panch)\s*bhk/i,
  /(\d)\s*room/i,
  /(\d)\s*kamra/i,        // Hindi: rooms
  /(\d)\s*kholi/i,        // Marathi: room
];

const WORD_TO_NUMBER = {
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'ek': 1, 'do': 2, 'teen': 3, 'chaar': 4, 'paanch': 5, 'panch': 5,
  'tin': 3, 'char': 4,  // Marathi variations
};

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGET EXTRACTION — Ranges, Approximate, Flexible
// ═══════════════════════════════════════════════════════════════════════════════

const BUDGET_PATTERNS = [
  // Standard: "60 lakh", "60L", "60lac"
  /(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l)\b/i,
  // Crore: "1.2 crore", "1.2cr"
  /(\d+(?:\.\d+)?)\s*(crore|crores|cr)\b/i,
  // Budget keyword prefix: "budget 60L", "budget: 60 lakh"
  /budget[:\s]*(?:rs\.?\s*)?(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|crore|crores|cr)/i,
  // Indian number format: "60,00,000"
  /(?:budget|price|range)[:\s]*(?:rs\.?\s*)?(\d{1,3}(?:,?\d{2})*(?:,?\d{3}))/i,
];

// Range patterns: "50 to 60 lakh", "50-60L", "50 se 60 lakh"
const BUDGET_RANGE_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(?:to|-|se|tak|–)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|crore|crores|cr)/i,
  /(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|cr|crore)\s*(?:to|-|se|–)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|cr|crore)/i,
];

// Approximate: "around 60L", "upto 70L", "within 50-60L", "approx 55 lakh"
const BUDGET_APPROX_PATTERNS = [
  /(?:around|approx|approximately|lagbhag|karib)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|cr|crore)/i,
  /(?:upto|up\s*to|tak|maximum|max)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|cr|crore)/i,
  /(?:within|under|below|niche|ke\s*andar)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|cr|crore)/i,
  /(?:minimum|min|kam\s*se\s*kam|atleast|at\s*least)\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l|cr|crore)/i,
];

// Flexible marker: "negotiable", "flexible", "adjust ho jayega"
const BUDGET_FLEXIBLE_PATTERNS = [
  /\b(negotiable|flexible|adjust|thoda\s+upar\s+niche)\b/i,
  /\b(adjust\s+ho\s*jayega|kam\s+chal\s*ega|badha\s+sakte)\b/i,
  /\b(plus\s*minus|thoda\s+flexible)\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTY TYPE — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const PROPERTY_TYPES = {
  'flat': ['flat', 'flats', 'apartment', 'apartments', 'apt', 'ghar', 'makan', 'makaan'],
  'plot': ['plot', 'plots', 'land', 'site', 'zameen', 'jamin', 'bhukhand'],
  'villa': ['villa', 'villas', 'bungalow', 'bungalows', 'bangla', 'kothi'],
  'row_house': ['row house', 'rowhouse', 'row-house', 'duplex', 'twin bungalow'],
  'penthouse': ['penthouse', 'pent house'],
  'shop': ['shop', 'shops', 'showroom', 'commercial', 'dukan', 'dukaan'],
  'office': ['office', 'office space'],
  'farmhouse': ['farmhouse', 'farm house', 'farm land', 'farmland'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// POSSESSION — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const POSSESSION_PATTERNS = {
  'immediate': [
    /\b(immediate|ready\s*to\s*move|ready\s*possession|rtm|ready)\b/i,
    /\b(turant|abhi|fauran|tayyar)\b/i,  // Hindi
    /\b(lagech|tayar)\b/i,                 // Marathi
  ],
  '6months': [
    /\b(6\s*month|six\s*month|within\s*6|possession\s*soon)\b/i,
    /\b(6\s*mahine|chah\s*mahine)\b/i,
  ],
  '1year': [
    /\b(1\s*year|one\s*year|under\s*construction|uc|ongoing)\b/i,
    /\b(ek\s*saal|1\s*saal)\b/i,
  ],
  '2year': [
    /\b(2\s*year|two\s*year|new\s*launch|pre[\s-]*launch)\b/i,
    /\b(do\s*saal|2\s*saal)\b/i,
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOAN — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const LOAN_PATTERNS = [
  /\b(loan|bank\s*loan|finance|emi|home\s*loan)\b/i,
  /\b(loan\s*(required|needed|chahiye|available|milega|lagna))\b/i,
  /\b(karz|karza|loan\s*wala)\b/i,  // Hindi
];

// ═══════════════════════════════════════════════════════════════════════════════
// URGENCY — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const URGENCY_PATTERNS = {
  'very_urgent': [
    /\b(very\s*urgent|asap|immediately|today|tomorrow)\b/i,
    /\b(bahut\s*jaldi|aaj|kal|fauran|turant)\b/i,
  ],
  'urgent': [
    /\b(urgent|urgently|quickly)\b/i,
    /\b(jaldi|jald|fatafat)\b/i,
  ],
  'normal': []
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION INDICATORS — Multi-Language
// ═══════════════════════════════════════════════════════════════════════════════

const LOCATION_INDICATORS = [
  // English
  'near', 'in', 'at', 'around', 'beside', 'behind', 'opposite',
  'close to', 'next to', 'area', 'locality', 'location',
  // Hindi
  'ke paas', 'ke pass', 'ke aas paas', 'mein', 'me', 'pe',
  'ke piche', 'ke samne', 'ke bagal', 'wale area',
  // Marathi
  'joval', 'javal', 'madhye', 'pasun',
];

// Multi-location separator patterns
const MULTI_LOCATION_SEPARATORS = /\s*(?:or|ya|athva|\/|,\s*or|,\s*ya)\s*/i;

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-REQUIREMENT SPLIT PATTERNS
// ═══════════════════════════════════════════════════════════════════════════════

// Patterns that indicate multiple requirements in one message
const MULTI_REQ_SEPARATORS = [
  /\s*(?:and\s+also|also\s+need|aur\s+ek|aur\s+bhi|plus)\s*/i,
  /\s*(?:\band\b)\s*(?=\d\s*bhk)/i,  // "AND" followed by BHK = new requirement
  /\s*(?:;\s*|\.{2,}\s*)/,            // Semicolons or ".." as separators
];

// ═══════════════════════════════════════════════════════════════════════════════
// FOLLOW-UP / CONTEXT REFERENCE PATTERNS
// ═══════════════════════════════════════════════════════════════════════════════

const FOLLOWUP_PATTERNS = [
  /\b(same\s+(area|location|jagah|ilaka)\s+(?:but|lekin|par|per))\b/i,
  /\b(wahi\s+jagah|same\s+place|wahi\s+area)\b/i,
  /\b(increase\s+budget|budget\s+badha|zyada\s+budget)\b/i,
  /\b(decrease\s+budget|budget\s+kam|kam\s+budget)\b/i,
  /\b(bigger|bada|bade\s+wala|chota|smaller)\b/i,
  /\b(same\s+but|aise\s+hi\s+but|waisa\s+hi\s+lekin)\b/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// DEDUPLICATION CACHE
// ═══════════════════════════════════════════════════════════════════════════════

// In-memory LRU cache to prevent duplicate extractions
// Key: hash of (userId + normalized text), TTL: 10 minutes
const DEDUP_CACHE = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_MAX_SIZE = 500;

function _generateDedupeKey(userId, text) {
  // Normalize: lowercase, collapse spaces, remove punctuation
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${userId}:${normalized}`;
}

function _isDuplicate(userId, text) {
  const key = _generateDedupeKey(userId, text);
  const entry = DEDUP_CACHE.get(key);
  if (entry && (Date.now() - entry.timestamp) < DEDUP_TTL_MS) {
    return true;
  }
  return false;
}

function _markAsSeen(userId, text) {
  const key = _generateDedupeKey(userId, text);
  DEDUP_CACHE.set(key, { timestamp: Date.now() });
  // Evict oldest if cache too large
  if (DEDUP_CACHE.size > DEDUP_MAX_SIZE) {
    const firstKey = DEDUP_CACHE.keys().next().value;
    DEDUP_CACHE.delete(firstKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class NLPExtractor {

  /**
   * Extract requirement parameters from a free-text message.
   * Returns a single extraction or null.
   * For multi-requirement messages, use extractAll().
   * 
   * @param {string} text - Raw chat message text
   * @param {object} context - Optional { role, userId, previousParams }
   * @returns {{ intent, confidence, params, extractedFrom } | null}
   */
  extract(text, context = {}) {
    if (!text || typeof text !== 'string' || text.trim().length < 5) {
      return null;
    }

    const cleanedText = text.trim();

    // Deduplication check
    if (context.userId && _isDuplicate(context.userId, cleanedText)) {
      return null;
    }

    // Negative intent check
    if (this._hasNegativeIntent(cleanedText)) {
      return null;
    }

    // Check for follow-up reference (needs context from previous messages)
    if (context.previousParams && this._isFollowUp(cleanedText)) {
      const merged = this._resolveFollowUp(cleanedText, context.previousParams);
      if (merged) {
        if (context.userId) _markAsSeen(context.userId, cleanedText);
        return {
          intent: 'follow_up_requirement',
          confidence: 0.8,
          params: merged,
          extractedFrom: cleanedText,
          isFollowUp: true
        };
      }
    }

    // Detect intent
    const intentResult = this._detectIntent(cleanedText);
    if (!intentResult.isRequirement) {
      // Implicit: if ≥3 params found without intent keywords
      const params = this._extractAllParams(cleanedText);
      const paramCount = this._countValidParams(params);
      if (paramCount >= 3) {
        if (context.userId) _markAsSeen(context.userId, cleanedText);
        return {
          intent: 'implicit_requirement',
          confidence: this._calibrateConfidence(0.3 + (paramCount * 0.15), params),
          params,
          extractedFrom: cleanedText
        };
      }
      return null;
    }

    // Extract all parameters
    const params = this._extractAllParams(cleanedText);
    const paramCount = this._countValidParams(params);

    if (paramCount < 1) return null;

    const rawConfidence = intentResult.confidence + (paramCount * 0.1);
    const confidence = this._calibrateConfidence(rawConfidence, params);

    if (context.userId) _markAsSeen(context.userId, cleanedText);

    return {
      intent: 'requirement',
      confidence,
      params,
      extractedFrom: cleanedText
    };
  }

  /**
   * Extract MULTIPLE requirements from a single message.
   * E.g., "need 2bhk manish nagar 60L and 3bhk besa 80L"
   * Returns array of extractions.
   * 
   * @param {string} text
   * @param {object} context
   * @returns {Array<{ intent, confidence, params, extractedFrom }>}
   */
  extractAll(text, context = {}) {
    if (!text || typeof text !== 'string' || text.trim().length < 5) {
      return [];
    }

    const cleanedText = text.trim();

    // Dedup check
    if (context.userId && _isDuplicate(context.userId, cleanedText)) {
      return [];
    }

    if (this._hasNegativeIntent(cleanedText)) return [];

    // Try to split into multiple requirements
    const segments = this._splitMultiRequirement(cleanedText);

    if (segments.length <= 1) {
      // Single requirement — use standard extract
      const single = this.extract(text, context);
      return single ? [single] : [];
    }

    // Multiple segments — extract from each
    const results = [];
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed.length < 5) continue;

      const params = this._extractAllParams(trimmed);
      const paramCount = this._countValidParams(params);
      if (paramCount < 1) continue;

      results.push({
        intent: 'requirement',
        confidence: this._calibrateConfidence(0.6 + (paramCount * 0.08), params),
        params,
        extractedFrom: trimmed
      });
    }

    if (results.length > 0 && context.userId) {
      _markAsSeen(context.userId, cleanedText);
    }

    return results;
  }

  /**
   * Quick signal check — cheaper than full extraction.
   */
  hasRequirementSignal(text) {
    if (!text || text.length < 8) return false;
    const hasIntent = REQUIREMENT_INTENT_PATTERNS.some(p => p.test(text));
    const hasBhk = BHK_PATTERNS.some(p => p.test(text));
    const hasBudget = BUDGET_PATTERNS.some(p => p.test(text)) ||
                      BUDGET_RANGE_PATTERNS.some(p => p.test(text));
    return hasIntent || (hasBhk && hasBudget);
  }

  /**
   * Check if message is a follow-up to a previous requirement.
   */
  isFollowUp(text) {
    return this._isFollowUp(text);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: Intent Detection
  // ═══════════════════════════════════════════════════════════════════════════

  _detectIntent(text) {
    let maxConfidence = 0;

    for (const pattern of REQUIREMENT_INTENT_PATTERNS) {
      if (pattern.test(text)) {
        let confidence = 0.5;
        // Higher confidence for explicit phrases
        if (/\b(looking\s+for|need|require|want|chahiye|pahije)\b/i.test(text)) confidence = 0.6;
        if (/\b(client\s+(needs?|wants?|ka\s+requirement))\b/i.test(text)) confidence = 0.75;
        if (/\b(lena\s+hai|kharidna\s+hai|ghyaycha)\b/i.test(text)) confidence = 0.7;
        maxConfidence = Math.max(maxConfidence, confidence);
      }
    }

    return { isRequirement: maxConfidence > 0, confidence: maxConfidence };
  }

  _hasNegativeIntent(text) {
    return NEGATIVE_INTENT_PATTERNS.some(p => p.test(text));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: Multi-Requirement Splitting
  // ═══════════════════════════════════════════════════════════════════════════

  _splitMultiRequirement(text) {
    // Check if text has multiple BHK mentions (strong signal of multi-req)
    const bhkMatches = text.match(/\d\s*bhk/gi);
    if (!bhkMatches || bhkMatches.length <= 1) {
      return [text]; // Single requirement
    }

    // Try splitting on known separators
    for (const separator of MULTI_REQ_SEPARATORS) {
      const parts = text.split(separator).filter(p => p.trim().length > 5);
      if (parts.length > 1) {
        // Verify each part has at least 1 BHK mention
        const validParts = parts.filter(p => /\d\s*bhk/i.test(p));
        if (validParts.length > 1) return validParts;
      }
    }

    // Fallback: split around BHK patterns (each BHK starts a new segment)
    // "2bhk manish nagar 60L 3bhk besa 80L" → ["2bhk manish nagar 60L", "3bhk besa 80L"]
    const bhkSplit = text.split(/(?=\d\s*bhk)/i).filter(p => {
      const trimmed = p.trim();
      // Must contain a BHK pattern and have reasonable length
      return trimmed.length > 5 && /\d\s*bhk/i.test(trimmed);
    });
    if (bhkSplit.length > 1) return bhkSplit;

    return [text];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: Follow-Up Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  _isFollowUp(text) {
    return FOLLOWUP_PATTERNS.some(p => p.test(text));
  }

  /**
   * Resolve a follow-up message against previous params.
   * E.g., "same area but 3bhk" + previous {bhkType: '2BHK', location: 'manish_nagar', budget: 60}
   * → {bhkType: '3BHK', location: 'manish_nagar', budget: 60}
   */
  _resolveFollowUp(text, previousParams) {
    // Start with previous params as base
    const merged = { ...previousParams };
    let changed = false;

    // Check for BHK change: "but 3bhk", "3bhk chahiye"
    const newBhk = this._extractBhk(text);
    if (newBhk && newBhk !== previousParams.bhkType) {
      merged.bhkType = newBhk;
      changed = true;
    }

    // Check for budget change
    const newBudget = this._extractBudget(text);
    if (newBudget && newBudget !== previousParams.budget) {
      merged.budget = newBudget;
      changed = true;
    }

    // "increase budget" / "budget badha"
    if (/\b(increase|badha|zyada|more)\b/i.test(text) && previousParams.budget) {
      const amount = this._extractBudget(text);
      if (amount) {
        merged.budget = amount;
      } else {
        merged.budget = Math.round(previousParams.budget * 1.15); // +15% default
      }
      changed = true;
    }

    // "decrease budget" / "budget kam"
    if (/\b(decrease|kam|less|reduce)\b/i.test(text) && previousParams.budget) {
      const amount = this._extractBudget(text);
      if (amount) {
        merged.budget = amount;
      } else {
        merged.budget = Math.round(previousParams.budget * 0.85); // -15% default
      }
      changed = true;
    }

    // "bigger" = +1 BHK
    if (/\b(bigger|bada|bade)\b/i.test(text) && previousParams.bhkType) {
      const currentBhk = parseInt(previousParams.bhkType);
      if (!isNaN(currentBhk) && currentBhk < 5) {
        merged.bhkType = `${currentBhk + 1}BHK`;
        changed = true;
      }
    }

    // "smaller" = -1 BHK
    if (/\b(smaller|chota|chhota)\b/i.test(text) && previousParams.bhkType) {
      const currentBhk = parseInt(previousParams.bhkType);
      if (!isNaN(currentBhk) && currentBhk > 1) {
        merged.bhkType = `${currentBhk - 1}BHK`;
        changed = true;
      }
    }

    // Check for new location (overrides "same area")
    if (!/\b(same|wahi|waisa)\b/i.test(text)) {
      const newLocation = this._extractLocation(text);
      // Only override if the extracted location resolves to a known canonical
      if (newLocation) {
        const norm = locationNormalizer.normalize(newLocation);
        if (norm.canonical && norm.confidence >= 0.6) {
          merged.location = newLocation;
          merged.locationRaw = this._extractLocationRaw(text);
          changed = true;
        }
      }
    }

    // Check for new property type
    const newPropType = this._extractPropertyType(text);
    if (newPropType && newPropType !== previousParams.propertyType) {
      merged.propertyType = newPropType;
      changed = true;
    }

    return changed ? merged : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: Parameter Extraction
  // ═══════════════════════════════════════════════════════════════════════════

  _extractAllParams(text) {
    const budgetResult = this._extractBudgetFull(text);
    return {
      bhkType: this._extractBhk(text),
      budget: budgetResult.min,
      budgetMax: budgetResult.max,
      budgetFlexible: budgetResult.flexible,
      location: this._extractLocation(text),
      locationRaw: this._extractLocationRaw(text),
      locations: this._extractMultipleLocations(text),  // NEW: array of locations
      locationCanonical: null,
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
        if (WORD_TO_NUMBER[num.toLowerCase()]) {
          num = WORD_TO_NUMBER[num.toLowerCase()];
        }
        const bhkNum = parseInt(num);
        if (bhkNum >= 1 && bhkNum <= 6) {
          if (/rk/i.test(match[0])) return '1RK';
          return `${bhkNum}BHK`;
        }
      }
    }
    return null;
  }

  /**
   * Full budget extraction with range and flexibility support.
   * Returns { min, max, flexible }
   */
  _extractBudgetFull(text) {
    let min = null;
    let max = null;
    let flexible = false;

    // Check flexibility markers
    if (BUDGET_FLEXIBLE_PATTERNS.some(p => p.test(text))) {
      flexible = true;
    }

    // Check for range first: "50 to 60 lakh", "50-60L"
    for (const pattern of BUDGET_RANGE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        if (match[4]) {
          // Pattern 2: "50 lakh to 60 lakh" — both have units
          min = this._parseBudgetValue(parseFloat(match[1]), match[2]);
          max = this._parseBudgetValue(parseFloat(match[3]), match[4]);
        } else {
          // Pattern 1: "50 to 60 lakh" — one unit at end
          min = this._parseBudgetValue(parseFloat(match[1]), match[3]);
          max = this._parseBudgetValue(parseFloat(match[2]), match[3]);
        }
        return { min, max, flexible };
      }
    }

    // Check approximate: "around 60L" → min=54, max=66 (±10%)
    for (const pattern of BUDGET_APPROX_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const value = this._parseBudgetValue(parseFloat(match[1]), match[2]);
        if (/upto|up\s*to|tak|maximum|max/i.test(match[0])) {
          min = null;
          max = value;
        } else if (/minimum|min|kam\s*se\s*kam|atleast/i.test(match[0])) {
          min = value;
          max = null;
        } else {
          // "around" — create a ±10% range
          min = Math.round(value * 0.9);
          max = Math.round(value * 1.1);
        }
        flexible = true;
        return { min: min || value, max, flexible };
      }
    }

    // Standard budget patterns
    for (const pattern of BUDGET_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = (match[2] || '').toLowerCase();
        min = this._parseBudgetValue(value, unit);
        if (min) return { min, max, flexible };
      }
    }

    // Fallback
    const budgetContext = text.match(/(\d+(?:\.\d+)?)\s*(l|lk|lakh|lac|cr|crore)\b/i);
    if (budgetContext) {
      min = this._parseBudgetValue(parseFloat(budgetContext[1]), budgetContext[2]);
    }

    return { min, max, flexible };
  }

  _parseBudgetValue(value, unit) {
    if (!value || isNaN(value)) return null;
    const u = (unit || '').toLowerCase();
    if (u.startsWith('cr')) return value * 100;
    if (u.startsWith('l') || u.startsWith('lac')) return value;
    if (value > 100000) return value / 100000;
    return value;
  }

  // Keep backward compatibility
  _extractBudget(text) {
    return this._extractBudgetFull(text).min;
  }

  _extractBudgetRange(text) {
    return this._extractBudgetFull(text).max;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: Location Extraction — Multi-Location + Landmark Support
  // ═══════════════════════════════════════════════════════════════════════════

  _extractLocation(text) {
    const rawLocation = this._extractLocationRaw(text);
    if (!rawLocation) return null;
    const normalized = locationNormalizer.normalize(rawLocation);
    return normalized.canonical || normalized.originalCleaned;
  }

  _extractLocationRaw(text) {
    const lowerText = text.toLowerCase();

    // Strategy 1: Find text after location indicator words
    for (const indicator of LOCATION_INDICATORS) {
      const idx = lowerText.indexOf(indicator);
      if (idx !== -1) {
        const afterIndicator = text.substring(idx + indicator.length).trim();
        const locationCandidate = this._extractLocationPhrase(afterIndicator);
        if (locationCandidate && locationCandidate.length >= 3) {
          return locationCandidate;
        }
      }
    }

    // Strategy 2: Check known locations in the text
    const knownMatch = locationNormalizer.normalize(lowerText);
    if (knownMatch.canonical && knownMatch.confidence >= 0.6) {
      return knownMatch.originalCleaned;
    }

    // Strategy 3: Capitalized phrases
    const capitalizedPhrases = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
    if (capitalizedPhrases) {
      for (const phrase of capitalizedPhrases) {
        const norm = locationNormalizer.normalize(phrase);
        if (norm.canonical) return phrase;
      }
    }

    return null;
  }

  /**
   * Extract MULTIPLE locations from a message.
   * "manish nagar or wardha road" → ['manish_nagar', 'wardha_road']
   * "near besa / pratap nagar area" → ['besa', 'pratap_nagar']
   */
  _extractMultipleLocations(text) {
    const lowerText = text.toLowerCase();

    // Strategy: find text after location indicators, then check for separators
    let locationChunk = null;

    for (const indicator of LOCATION_INDICATORS) {
      const idx = lowerText.indexOf(indicator);
      if (idx !== -1) {
        // Take everything after the indicator up to a budget/bhk pattern or end
        const after = text.substring(idx + indicator.length).trim();
        const chunk = after
          .replace(/\d+\s*(lakh|lakhs|lac|lacs|l|cr|crore|bhk)\b.*/i, '')
          .replace(/budget.*/i, '')
          .replace(/loan.*/i, '')
          .trim();
        if (chunk.length >= 3) {
          locationChunk = chunk;
          break;
        }
      }
    }

    if (!locationChunk) {
      // Fallback: use raw location
      const raw = this._extractLocationRaw(text);
      if (!raw) return [];
      locationChunk = raw;
    }

    // Check if the chunk contains multi-location separators
    const parts = locationChunk.split(MULTI_LOCATION_SEPARATORS).filter(p => p.trim().length >= 3);

    if (parts.length <= 1) {
      // Single location
      const norm = locationNormalizer.normalize(locationChunk);
      if (norm.canonical) return [norm.canonical];
      if (norm.originalCleaned && norm.originalCleaned.length >= 3) return [norm.originalCleaned];
      return [];
    }

    // Multiple locations
    const locations = [];
    for (const part of parts) {
      const norm = locationNormalizer.normalize(part.trim());
      if (norm.canonical) {
        locations.push(norm.canonical);
      } else if (norm.originalCleaned && norm.originalCleaned.length >= 3) {
        locations.push(norm.originalCleaned);
      }
    }

    return [...new Set(locations)]; // Deduplicate
  }

  _extractLocationPhrase(text) {
    let cleaned = text
      .replace(/\d+\s*(bhk|lakh|lakhs|lac|l|cr|crore|budget)/gi, '')
      .replace(/[,.].*$/, '')
      .trim();

    const words = cleaned.split(/\s+/).slice(0, 4);
    const stopWords = [
      'budget', 'price', 'bhk', 'flat', 'plot', 'villa', 'loan',
      'urgent', 'ready', 'immediate', 'chahiye', 'pahije', 'lakh',
      'wala', 'wali', 'and', 'aur', 'or', 'ya',
    ];
    const locationWords = [];
    for (const word of words) {
      if (stopWords.includes(word.toLowerCase())) break;
      if (/^\d+$/.test(word)) break;
      locationWords.push(word);
    }

    return locationWords.join(' ').trim();
  }

  _extractPropertyType(text) {
    const lowerText = text.toLowerCase();
    for (const [type, keywords] of Object.entries(PROPERTY_TYPES)) {
      for (const keyword of keywords) {
        // Use word boundary for short keywords to avoid false positives
        if (keyword.length <= 4) {
          const regex = new RegExp(`\\b${keyword}\\b`, 'i');
          if (regex.test(lowerText)) return type;
        } else {
          if (lowerText.includes(keyword)) return type;
        }
      }
    }
    return null;
  }

  _extractPossession(text) {
    for (const [timeline, patterns] of Object.entries(POSSESSION_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) return timeline;
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
        if (pattern.test(text)) return level;
      }
    }
    return 'normal';
  }

  _extractCity(text) {
    const cities = [
      'nagpur', 'mumbai', 'pune', 'nashik', 'aurangabad',
      'hyderabad', 'bangalore', 'delhi', 'noida', 'gurgaon',
      'thane', 'navi mumbai', 'indore', 'bhopal', 'jaipur',
      'chandigarh', 'kolkata', 'chennai', 'ahmedabad', 'surat',
      'lucknow', 'amravati', 'wardha', 'chandrapur', 'akola',
    ];

    const lowerText = text.toLowerCase();
    for (const city of cities) {
      if (lowerText.includes(city)) {
        return city.charAt(0).toUpperCase() + city.slice(1);
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: Confidence Calibration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calibrate confidence based on what params were extracted.
   * Higher confidence when we have BHK + Budget + Location (the "golden trio").
   * Lower confidence for vague extractions.
   */
  _calibrateConfidence(rawConfidence, params) {
    let bonus = 0;
    let penalty = 0;

    // Golden trio: BHK + Budget + Location
    const hasGoldenTrio = params.bhkType && params.budget && params.location;
    if (hasGoldenTrio) bonus += 0.15;

    // Strong signals
    if (params.bhkType && params.budget) bonus += 0.05;
    if (params.location && params.budget) bonus += 0.05;
    if (params.propertyType) bonus += 0.03;
    if (params.possessionNeeded) bonus += 0.02;

    // Weak/vague signals reduce confidence
    if (!params.bhkType && !params.budget) penalty += 0.15;
    if (!params.location && !params.city) penalty += 0.1;

    // Budget without BHK or location is often noise
    if (params.budget && !params.bhkType && !params.location) penalty += 0.1;

    const calibrated = rawConfidence + bonus - penalty;
    return Math.max(0.1, Math.min(0.95, calibrated));
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
