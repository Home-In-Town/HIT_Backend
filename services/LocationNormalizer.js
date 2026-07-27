/**
 * LocationNormalizer
 * 
 * Handles fuzzy location matching so that:
 *   "Manish Nagar", "near Manish Nagar", "Manish Nagar road", "manish nagar ext"
 * all resolve to the same canonical location and match against projects in that area.
 * 
 * Strategy:
 * 1. Strip noise words (near, road, ext, extension, behind, opposite, beside, etc.)
 * 2. Normalize to a canonical form using alias map
 * 3. Fuzzy match using Levenshtein distance for typo tolerance
 * 4. Support lat/lng radius matching when coordinates are available
 */

const Logger = require('../utils/logger');
const logger = new Logger('LocationNormalizer');

// ─── Noise Words to Strip ────────────────────────────────────────────────────
const NOISE_WORDS = [
  'near', 'nearby', 'beside', 'behind', 'opposite', 'opp', 'next to',
  'in front of', 'close to', 'around', 'towards', 'facing',
  'road', 'rd', 'street', 'st', 'lane', 'gali',
  'extension', 'ext', 'phase', 'sector',
  'area', 'locality', 'colony', 'nagar', 'ward',
  'main', 'new', 'old'
];

// Words that should NOT be stripped if they are part of the place name
const PROTECTED_COMPOUND_WORDS = [
  'manish nagar', 'dharampeth', 'sitabuldi', 'sadar', 'civil lines',
  'manewada', 'besa', 'koradi', 'hingna', 'wadi', 'wardha road',
  'amravati road', 'kamptee', 'katol road', 'nagpur', 'ramdaspeth',
  'bajaj nagar', 'laxmi nagar', 'pratap nagar', 'trimurti nagar',
  'friends colony', 'shankar nagar', 'gandhi nagar', 'nehru nagar',
  'sneh nagar', 'ram nagar', 'shivaji nagar', 'ambazari', 'seminary hills',
  'byramji town', 'itwari', 'mahal', 'gokulpeth', 'lakadganj',
  'khamla', 'law college square', 'pande layout', 'nandanvan',
  'narendra nagar', 'somalwada', 'jaripatka', 'kalamna', 'wathoda',
  'hudkeshwar', 'beltarodi', 'pipla', 'zingabai takli', 'dighori',
  'dabha', 'mouza', 'umred road', 'kharbi', 'fetri', 'parseoni'
];

// ─── Alias Map: Variations → Canonical Name ─────────────────────────────────
// This map grows over time as more locations are encountered
const LOCATION_ALIASES = {
  // Manish Nagar area
  'manish nagar': 'manish_nagar',
  'manish ngr': 'manish_nagar',
  'manishnagar': 'manish_nagar',
  'manish nagar road': 'manish_nagar',
  'manish nagar ext': 'manish_nagar',
  'manish nagar extension': 'manish_nagar',

  // Manewada
  'manewada': 'manewada',
  'manewada road': 'manewada',
  'maneywada': 'manewada',
  'manewada ring road': 'manewada',

  // Dharampeth
  'dharampeth': 'dharampeth',
  'dharampeth ext': 'dharampeth',

  // Wardha Road
  'wardha road': 'wardha_road',
  'wardha rd': 'wardha_road',

  // Besa
  'besa': 'besa',
  'besa road': 'besa',
  'besa square': 'besa',

  // Hingna
  'hingna': 'hingna',
  'hingna road': 'hingna',
  'hingna midc': 'hingna',

  // Katol Road
  'katol road': 'katol_road',
  'katol rd': 'katol_road',

  // Koradi
  'koradi': 'koradi',
  'koradi road': 'koradi',

  // Amravati Road
  'amravati road': 'amravati_road',
  'amravati rd': 'amravati_road',

  // Pratap Nagar
  'pratap nagar': 'pratap_nagar',
  'pratapnagar': 'pratap_nagar',

  // Trimurti Nagar
  'trimurti nagar': 'trimurti_nagar',
  'trimurtinagar': 'trimurti_nagar',

  // Laxmi Nagar
  'laxmi nagar': 'laxmi_nagar',
  'laxminagar': 'laxmi_nagar',

  // Bajaj Nagar
  'bajaj nagar': 'bajaj_nagar',
  'bajajnagar': 'bajaj_nagar',

  // Civil Lines
  'civil lines': 'civil_lines',
  'civillines': 'civil_lines',

  // Sadar
  'sadar': 'sadar',
  'sadar bazaar': 'sadar',

  // Sitabuldi
  'sitabuldi': 'sitabuldi',
  'sitaburdi': 'sitabuldi',

  // Ramdaspeth
  'ramdaspeth': 'ramdaspeth',
  'ramdas peth': 'ramdaspeth',

  // Somalwada
  'somalwada': 'somalwada',
  'somal wada': 'somalwada',

  // Hudkeshwar
  'hudkeshwar': 'hudkeshwar',
  'hudkeshwar road': 'hudkeshwar',

  // Wadi
  'wadi': 'wadi',
  'wadi area': 'wadi',

  // Nandanvan
  'nandanvan': 'nandanvan',
  'nandanwan': 'nandanvan',

  // Seminary Hills
  'seminary hills': 'seminary_hills',
  'seminary hill': 'seminary_hills',
};

// ─── Canonical → Known Coordinates (approx center of locality) ──────────────
const LOCATION_COORDS = {
  'manish_nagar': { lat: 21.1100, lng: 79.0400 },
  'manewada': { lat: 21.1680, lng: 79.0800 },
  'dharampeth': { lat: 21.1450, lng: 79.0750 },
  'wardha_road': { lat: 21.1100, lng: 79.1200 },
  'besa': { lat: 21.0850, lng: 79.0500 },
  'hingna': { lat: 21.1000, lng: 78.9800 },
  'katol_road': { lat: 21.1700, lng: 79.0500 },
  'koradi': { lat: 21.2300, lng: 79.1000 },
  'amravati_road': { lat: 21.1600, lng: 79.0200 },
  'pratap_nagar': { lat: 21.1350, lng: 79.0550 },
  'trimurti_nagar': { lat: 21.1250, lng: 79.0300 },
  'laxmi_nagar': { lat: 21.1400, lng: 79.0850 },
  'bajaj_nagar': { lat: 21.1380, lng: 79.0650 },
  'civil_lines': { lat: 21.1500, lng: 79.0900 },
  'sadar': { lat: 21.1550, lng: 79.0850 },
  'sitabuldi': { lat: 21.1470, lng: 79.0820 },
  'ramdaspeth': { lat: 21.1420, lng: 79.0800 },
  'somalwada': { lat: 21.1600, lng: 79.1100 },
  'hudkeshwar': { lat: 21.0950, lng: 79.1100 },
  'wadi': { lat: 21.1500, lng: 79.0300 },
  'nandanvan': { lat: 21.1300, lng: 79.1050 },
  'seminary_hills': { lat: 21.1530, lng: 79.0700 },
};

// Reverse map: canonical → all known aliases
const CANONICAL_TO_ALIASES = {};
for (const [alias, canonical] of Object.entries(LOCATION_ALIASES)) {
  if (!CANONICAL_TO_ALIASES[canonical]) {
    CANONICAL_TO_ALIASES[canonical] = [];
  }
  CANONICAL_TO_ALIASES[canonical].push(alias);
}

class LocationNormalizer {

  /**
   * Normalize a raw location string to a canonical form.
   * Returns: { canonical, confidence, originalCleaned }
   * 
   * @param {string} rawLocation - Raw text like "near Manish Nagar road"
   * @returns {{ canonical: string|null, confidence: number, originalCleaned: string, coords: object|null }}
   */
  normalize(rawLocation) {
    if (!rawLocation || typeof rawLocation !== 'string') {
      return { canonical: null, confidence: 0, originalCleaned: '', coords: null };
    }

    const cleaned = this._cleanLocation(rawLocation);

    // 1. Direct alias lookup
    const directMatch = LOCATION_ALIASES[cleaned];
    if (directMatch) {
      return {
        canonical: directMatch,
        confidence: 1.0,
        originalCleaned: cleaned,
        coords: LOCATION_COORDS[directMatch] || null
      };
    }

    // 2. Check if cleaned text contains any known alias (substring match)
    for (const [alias, canonical] of Object.entries(LOCATION_ALIASES)) {
      if (cleaned.includes(alias) || alias.includes(cleaned)) {
        return {
          canonical,
          confidence: 0.85,
          originalCleaned: cleaned,
          coords: LOCATION_COORDS[canonical] || null
        };
      }
    }

    // 3. Fuzzy match using Levenshtein distance
    const fuzzyResult = this._fuzzyMatch(cleaned);
    if (fuzzyResult) {
      return {
        canonical: fuzzyResult.canonical,
        confidence: fuzzyResult.confidence,
        originalCleaned: cleaned,
        coords: LOCATION_COORDS[fuzzyResult.canonical] || null
      };
    }

    // 4. No match found — return cleaned text as-is for DB regex fallback
    return {
      canonical: null,
      confidence: 0,
      originalCleaned: cleaned,
      coords: null
    };
  }

  /**
   * Check if two location strings refer to the same area.
   * Used to compare a requirement location with a project location.
   * 
   * @param {string} location1 - First location (e.g., from chat message)
   * @param {string} location2 - Second location (e.g., from project)
   * @param {object} coords2 - Optional {lat, lng} of the project
   * @returns {{ matches: boolean, confidence: number, method: string }}
   */
  isSameArea(location1, location2, coords2 = null) {
    const norm1 = this.normalize(location1);
    const norm2 = this.normalize(location2);

    // Both resolved to same canonical
    if (norm1.canonical && norm2.canonical && norm1.canonical === norm2.canonical) {
      return {
        matches: true,
        confidence: Math.min(norm1.confidence, norm2.confidence),
        method: 'canonical_match'
      };
    }

    // One resolved, try coordinate distance
    if (norm1.coords && coords2 && coords2.lat && coords2.lng) {
      const distance = this._haversineKm(norm1.coords, coords2);
      if (distance <= 2) {
        return { matches: true, confidence: 0.9, method: 'geo_proximity_2km' };
      }
      if (distance <= 5) {
        return { matches: true, confidence: 0.7, method: 'geo_proximity_5km' };
      }
    }

    // Fallback: substring match on cleaned strings
    const clean1 = norm1.originalCleaned;
    const clean2 = norm2.originalCleaned;

    if (clean1 && clean2) {
      if (clean1.includes(clean2) || clean2.includes(clean1)) {
        return { matches: true, confidence: 0.6, method: 'substring_fallback' };
      }

      // Trigram similarity
      const similarity = this._trigramSimilarity(clean1, clean2);
      if (similarity >= 0.5) {
        return { matches: true, confidence: similarity * 0.8, method: 'trigram_similarity' };
      }
    }

    return { matches: false, confidence: 0, method: 'no_match' };
  }

  /**
   * Get all known aliases for a canonical location.
   */
  getAliases(canonical) {
    return CANONICAL_TO_ALIASES[canonical] || [];
  }

  /**
   * Build a MongoDB regex that matches any alias of a location.
   * Useful for querying projects by location.
   * 
   * @param {string} rawLocation - Raw location text
   * @returns {RegExp|null} - Regex for MongoDB query, or null
   */
  buildLocationRegex(rawLocation) {
    const norm = this.normalize(rawLocation);

    if (norm.canonical) {
      const aliases = this.getAliases(norm.canonical);
      if (aliases.length > 0) {
        // Build a regex that matches any alias
        const patterns = aliases.map(a => a.replace(/\s+/g, '\\s*'));
        return new RegExp(patterns.join('|'), 'i');
      }
    }

    // Fallback: use the cleaned text as a fuzzy regex
    if (norm.originalCleaned) {
      // Allow optional spaces and common suffixes
      const escaped = norm.originalCleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flexible = escaped.replace(/\s+/g, '\\s*');
      return new RegExp(flexible, 'i');
    }

    return null;
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Clean a location string: lowercase, trim, remove noise words
   */
  _cleanLocation(raw) {
    let text = raw.toLowerCase().trim();

    // Remove punctuation except hyphens
    text = text.replace(/[,.'"\/#!$%\^&\*;:{}=_`~()]/g, '');

    // Check if text matches a protected compound word — don't strip from it
    for (const compound of PROTECTED_COMPOUND_WORDS) {
      if (text.includes(compound)) {
        // Strip only prefix noise (near, behind, etc.)
        const prefixNoises = ['near', 'nearby', 'beside', 'behind', 'opposite', 'opp',
          'next to', 'in front of', 'close to', 'around', 'towards', 'facing'];
        for (const noise of prefixNoises) {
          if (text.startsWith(noise + ' ')) {
            text = text.substring(noise.length).trim();
          }
        }
        return text.trim();
      }
    }

    // General noise word removal
    for (const noise of NOISE_WORDS) {
      // Only remove if it appears as a separate word
      const regex = new RegExp(`\\b${noise}\\b`, 'gi');
      text = text.replace(regex, ' ');
    }

    // Collapse multiple spaces
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }

  /**
   * Fuzzy match using Levenshtein distance against all known aliases
   */
  _fuzzyMatch(cleaned) {
    let bestMatch = null;
    let bestDistance = Infinity;
    const maxAllowedDistance = Math.max(2, Math.floor(cleaned.length * 0.3));

    for (const [alias, canonical] of Object.entries(LOCATION_ALIASES)) {
      const distance = this._levenshtein(cleaned, alias);
      if (distance < bestDistance && distance <= maxAllowedDistance) {
        bestDistance = distance;
        bestMatch = { canonical, alias, distance };
      }
    }

    if (bestMatch) {
      // Confidence decreases with edit distance
      const maxLen = Math.max(cleaned.length, bestMatch.alias.length);
      const confidence = Math.max(0.4, 1 - (bestMatch.distance / maxLen));
      return { canonical: bestMatch.canonical, confidence };
    }

    return null;
  }

  /**
   * Levenshtein distance between two strings
   */
  _levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Trigram similarity (Jaccard index on character trigrams)
   */
  _trigramSimilarity(a, b) {
    const trigramsA = this._getTrigrams(a);
    const trigramsB = this._getTrigrams(b);

    const setA = new Set(trigramsA);
    const setB = new Set(trigramsB);

    let intersection = 0;
    for (const tri of setA) {
      if (setB.has(tri)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  _getTrigrams(str) {
    const padded = `  ${str} `;
    const trigrams = [];
    for (let i = 0; i < padded.length - 2; i++) {
      trigrams.push(padded.substring(i, i + 3));
    }
    return trigrams;
  }

  /**
   * Haversine distance in kilometers between two {lat, lng} points
   */
  _haversineKm(point1, point2) {
    const R = 6371; // Earth radius in km
    const dLat = this._toRad(point2.lat - point1.lat);
    const dLng = this._toRad(point2.lng - point1.lng);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this._toRad(point1.lat)) * Math.cos(this._toRad(point2.lat)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  _toRad(deg) {
    return deg * (Math.PI / 180);
  }
}

module.exports = new LocationNormalizer();
