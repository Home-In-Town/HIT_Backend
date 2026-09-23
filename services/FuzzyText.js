/**
 * FuzzyText — tolerant text comparison for real-world property data.
 *
 * Property listings are typed by hand, on phones, by people in a hurry. The same
 * locality arrives as "Manish Nagar", "manish ngr", "MANISHNAGAR", "Manish  Nagar ",
 * "Manish Nagar Rd". Exact comparison throws all of those away, which is why one
 * misspelled field used to produce zero matches.
 *
 * This module provides the primitives; callers decide how to score the result.
 * Everything is pure and synchronous — no DB, no network.
 *
 * Design notes:
 *   - `squash()` is the cheap win: removing ALL whitespace makes "civillines" and
 *     "Civil Lines" identical, which covers a huge share of real typos.
 *   - Abbreviations are expanded BEFORE distance is measured, so "ngr" → "nagar"
 *     costs nothing instead of 2 edits.
 *   - Token-set comparison handles reordering ("Nagar Manish") and extra words
 *     ("Manish Nagar Extension Road") without inflating edit distance.
 *   - Thresholds are length-aware: 1 edit in a 4-letter word is a different word,
 *     1 edit in a 14-letter word is a typo.
 */

// Words that carry no identifying information in an Indian address. Stripped
// before comparison so "Manish Nagar Road" still matches "Manish Nagar".
const NOISE_WORDS = new Set([
  'near', 'nearby', 'beside', 'behind', 'opposite', 'opp', 'front', 'facing',
  'road', 'rd', 'street', 'st', 'lane', 'ln', 'marg', 'chowk', 'square',
  'area', 'zone', 'sector', 'block', 'phase', 'ext', 'extension', 'extn',
  'main', 'cross', 'bypass', 'highway', 'nh', 'sh',
  'the', 'at', 'in', 'on', 'of', 'and',
]);

// Common abbreviations and misspellings in Indian locality / city names.
// Expanded to the canonical long form before distance is computed.
const ABBREVIATIONS = {
  ngr: 'nagar', nagr: 'nagar', nager: 'nagar', ngar: 'nagar',
  colny: 'colony', clny: 'colony', col: 'colony',
  soc: 'society', socty: 'society', society: 'society',
  apt: 'apartment', apts: 'apartment', aprt: 'apartment',
  bldg: 'building', bld: 'building',
  gdn: 'garden', grdn: 'garden',
  vih: 'vihar', vhr: 'vihar',
  pkwy: 'parkway', pk: 'park',
  cmplx: 'complex', cplx: 'complex',
  twp: 'township', twnshp: 'township',
  gr: 'greater', gt: 'greater',
  e: 'east', w: 'west', n: 'north', s: 'south',
  estn: 'eastern', wstn: 'western',
  hsg: 'housing',
  res: 'residency', resi: 'residency', rsdncy: 'residency',
  vil: 'village', vlg: 'village',
  tal: 'taluka', dist: 'district',
  mh: 'maharashtra', mp: 'madhya pradesh', up: 'uttar pradesh',
};

// Frequently misspelled city names → canonical spelling. Cheap, high-value:
// these are the cities the platform actually operates in.
const CITY_CORRECTIONS = {
  nagpur: 'nagpur', ngpur: 'nagpur', nagpr: 'nagpur', nagur: 'nagpur',
  nagpour: 'nagpur', naghpur: 'nagpur', nagpure: 'nagpur',
  pune: 'pune', puna: 'pune', poona: 'pune', pnue: 'pune',
  mumbai: 'mumbai', bombay: 'mumbai', mumbei: 'mumbai', mumabi: 'mumbai',
  nashik: 'nashik', nasik: 'nashik', nashink: 'nashik',
  thane: 'thane', thana: 'thane',
  amravati: 'amravati', amaravati: 'amravati', amrawati: 'amravati',
  aurangabad: 'aurangabad', arangabad: 'aurangabad',
  wardha: 'wardha', warda: 'wardha',
  chandrapur: 'chandrapur', chandarpur: 'chandrapur',
  akola: 'akola', akolla: 'akola',
  bhopal: 'bhopal', bhopaal: 'bhopal',
  indore: 'indore', indor: 'indore',
  raipur: 'raipur', raypur: 'raipur',
  hyderabad: 'hyderabad', hydrabad: 'hyderabad', hyderbad: 'hyderabad',
  bengaluru: 'bengaluru', bangalore: 'bengaluru', banglore: 'bengaluru',
  delhi: 'delhi', dilli: 'delhi', newdelhi: 'delhi',
};

class FuzzyText {
  /**
   * Lowercase, strip accents and punctuation, collapse whitespace.
   * The baseline for every other operation here.
   */
  clean(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')   // drop combining accents
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')      // punctuation → space
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** clean() with ALL whitespace removed — makes spacing differences free. */
  squash(raw) {
    return this.clean(raw).replace(/\s+/g, '');
  }

  /** Split into meaningful tokens: cleaned, abbreviations expanded, noise dropped. */
  tokens(raw, { keepNoise = false } = {}) {
    const out = [];
    for (const word of this.clean(raw).split(' ')) {
      if (!word) continue;
      const expanded = ABBREVIATIONS[word] || word;
      // An abbreviation may expand to two words ("madhya pradesh").
      for (const part of expanded.split(' ')) {
        if (!part) continue;
        if (!keepNoise && NOISE_WORDS.has(part)) continue;
        out.push(part);
      }
    }
    // Everything was noise (e.g. "near the road") — fall back to keeping it, so
    // we compare something rather than two empty strings.
    if (out.length === 0 && !keepNoise) return this.tokens(raw, { keepNoise: true });
    return out;
  }

  /** Canonical comparison key: expanded, noise-free, order-independent, unspaced. */
  key(raw) {
    return this.tokens(raw).slice().sort().join('');
  }

  /** Levenshtein edit distance. Two-row DP, O(min(n,m)) memory. */
  levenshtein(a, b) {
    if (a === b) return 0;
    if (!a) return b ? b.length : 0;
    if (!b) return a.length;
    if (a.length < b.length) { const t = a; a = b; b = t; }

    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      const cur = new Array(b.length + 1);
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** Edit-distance similarity of two raw strings, 0..1. */
  similarity(a, b) {
    const x = this.squash(a);
    const y = this.squash(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const max = Math.max(x.length, y.length);
    return Math.max(0, 1 - this.levenshtein(x, y) / max);
  }

  /**
   * Edit distance a typo is allowed to be, given word length. Short words must
   * match (almost) exactly — "besa" vs "bela" are different places.
   */
  _budget(len) {
    if (len <= 4) return 0;
    if (len <= 6) return 1;
    if (len <= 10) return 2;
    return 3;
  }

  /** Are two single tokens the same word, allowing for a typo? */
  tokenMatch(a, b) {
    if (a === b) return true;
    const budget = this._budget(Math.max(a.length, b.length));
    if (budget === 0) return false;
    // A prefix that is long enough is a safe match ("manishnag" vs "manishnagar").
    if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
    return this.levenshtein(a, b) <= budget;
  }

  /**
   * Token-set similarity, 0..1. Order-independent and tolerant of extra words:
   * each token of the shorter set is matched to its best partner in the other.
   */
  tokenSetSimilarity(a, b) {
    const ta = this.tokens(a);
    const tb = this.tokens(b);
    if (!ta.length || !tb.length) return 0;

    const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const used = new Set();
    let hits = 0;

    for (const t of small) {
      for (let i = 0; i < large.length; i++) {
        if (used.has(i)) continue;
        if (this.tokenMatch(t, large[i])) { used.add(i); hits++; break; }
      }
    }
    return hits / small.length;
  }

  /**
   * The main entry point: how close are these two place/type names?
   * Returns { score: 0..1, method } so callers can grade rather than boolean.
   */
  compare(a, b) {
    if (!a || !b) return { score: 0, method: 'missing' };

    const sa = this.squash(a);
    const sb = this.squash(b);
    if (sa && sa === sb) return { score: 1, method: 'exact_ignoring_spaces' };

    const ka = this.key(a);
    const kb = this.key(b);
    if (ka && ka === kb) return { score: 0.97, method: 'exact_normalised' };

    // Containment: "manish nagar" inside "manish nagar extension".
    if (sa.length >= 4 && sb.length >= 4 && (sa.includes(sb) || sb.includes(sa))) {
      return { score: 0.85, method: 'containment' };
    }

    const tset = this.tokenSetSimilarity(a, b);
    if (tset >= 1) return { score: 0.92, method: 'all_tokens_match' };
    if (tset >= 0.5) return { score: 0.6 + (tset - 0.5) * 0.5, method: 'token_overlap' };

    // Whole-string typo fallback. Gated on the SAME length budget as tokenMatch:
    // a ratio alone would call "Besa" and "Bela" a typo of each other, and those
    // are two different localities. Short strings must match (almost) exactly.
    const dist = this.levenshtein(sa, sb);
    const budget = this._budget(Math.max(sa.length, sb.length));
    if (budget > 0 && dist <= budget) {
      const sim = 1 - dist / Math.max(sa.length, sb.length);
      if (sim >= 0.82) return { score: sim * 0.9, method: 'typo' };
      if (sim >= 0.7) return { score: sim * 0.7, method: 'loose_typo' };
    }

    return { score: 0, method: 'different' };
  }

  /** Boolean convenience wrapper. */
  isNear(a, b, threshold = 0.7) {
    return this.compare(a, b).score >= threshold;
  }

  /**
   * Canonicalise a city name, correcting known misspellings. Falls back to a
   * fuzzy sweep over the known list before giving up.
   */
  canonicalCity(raw) {
    const squashed = this.squash(raw);
    if (!squashed) return '';
    if (CITY_CORRECTIONS[squashed]) return CITY_CORRECTIONS[squashed];

    let best = null;
    let bestDist = Infinity;
    const budget = this._budget(squashed.length);
    for (const variant of Object.keys(CITY_CORRECTIONS)) {
      const d = this.levenshtein(squashed, variant);
      if (d < bestDist && d <= budget) { bestDist = d; best = CITY_CORRECTIONS[variant]; }
    }
    return best || squashed;
  }

  /**
   * Graded city comparison, tolerant of misspellings.
   * Returns { score: 0..1, method }.
   */
  compareCity(a, b) {
    if (!a || !b) return { score: 0, method: 'missing' };
    const ca = this.canonicalCity(a);
    const cb = this.canonicalCity(b);
    if (ca && ca === cb) return { score: 1, method: 'city_exact' };
    return this.compare(ca, cb);
  }
}

module.exports = new FuzzyText();
module.exports.FuzzyText = FuzzyText;
