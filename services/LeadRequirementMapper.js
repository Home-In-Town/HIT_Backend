'use strict';

/**
 * LeadRequirementMapper
 *
 * Turns a HumanLead (a CRM lead typed in by an agent) into the plain
 * requirement object MatchEngineV2 expects, and decides whether a lead carries
 * enough information to be matched at all.
 *
 * WHY THIS LAYER EXISTS
 * The engine's contract is strict and unit-sensitive in ways that are easy to
 * get silently wrong:
 *   - `budget` / `budgetMax` must be NUMBERS IN LAKHS  (₹50,00,000 → 50)
 *   - `area` must be SQFT                              (2 acres → 87120)
 *   - `bhkType` must look like "2BHK"
 *   - locality and city must be SEPARATE fields — the engine scores them
 *     independently and falls back to city when the locality misses
 * A wrong unit does not throw; it just produces confidently wrong matches. So
 * every conversion lives here, once, and is unit-tested.
 *
 * It also bridges the legacy free-text fields (`budget: "50-60L"`,
 * `homeType: "2 BHK"`, `location: "Besa, Nagpur"`) so leads that were created
 * before structured requirements existed can still be qualified and matched
 * without anyone re-typing them. Every legacy-derived value is reported in
 * `derivedFrom` so the caller can tell what was inferred rather than entered.
 */

const locationNormalizer = require('./LocationNormalizer');
const propertyTypeNormalizer = require('./PropertyTypeNormalizer');

const SQFT_PER_ACRE = 43560;

// Below this, a bare number is read as lakhs; at or above it, as rupees.
// Real-estate budgets in lakhs live in the 1–1000 range; rupee amounts for the
// same properties are 1,00,000+. There is no overlap in practice.
const RUPEE_THRESHOLD = 100000;

class LeadRequirementMapper {

  // ─── Unit + format parsing ────────────────────────────────────────────────

  /**
   * Convert an area to sqft. Returns null for unusable input.
   * The engine compares against a project's plot/carpet size range, which is
   * always sqft, so acres MUST be converted or a 2-acre plot scores as 2 sqft.
   */
  toSqft(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (String(unit).toLowerCase() === 'acres') return Math.round(n * SQFT_PER_ACRE);
    return Math.round(n);
  }

  /**
   * Parse a free-text budget into { budget, budgetMax } in LAKHS.
   *
   * Handles what agents actually type:
   *   "50"          → { budget: 50 }
   *   "50L"         → { budget: 50 }
   *   "50 lakh"     → { budget: 50 }
   *   "1.2Cr"       → { budget: 120 }
   *   "₹1,20,00,000"→ { budget: 120 }
   *   "50-60L"      → { budget: 50,  budgetMax: 60 }
   *   "80L - 1.2Cr" → { budget: 80,  budgetMax: 120 }   (per-side units)
   *   "1 to 1.5 cr" → { budget: 100, budgetMax: 150 }
   *
   * Ranges are split FIRST and each side parsed independently, so mixed-unit
   * ranges like "80L-1.2Cr" work. A side with no unit inherits the other's.
   */
  parseBudget(raw) {
    const empty = { budget: null, budgetMax: null };
    if (raw == null) return empty;

    // A number straight from the structured form needs no parsing.
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw <= 0) return empty;
      return { budget: raw >= RUPEE_THRESHOLD ? raw / RUPEE_THRESHOLD : raw, budgetMax: null };
    }

    const text = String(raw).toLowerCase().replace(/[₹,\s]/g, '');
    if (!text) return empty;

    // Split a range on "-", "to" or an en/em dash.
    const sides = text.split(/-{1,2}|–|—|to/).filter((s) => /\d/.test(s));
    if (sides.length === 0) return empty;

    const unitOf = (s) => {
      if (/cr|crore/.test(s)) return 'cr';
      if (/lakh|lac|\dl|l$/.test(s)) return 'l';
      return null;
    };

    // A unit stated on either side applies to a side that omitted one.
    const fallbackUnit = unitOf(sides[0]) || unitOf(sides[1] || '') || null;

    const valueOf = (s) => {
      const m = String(s).match(/\d+(?:\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0]);
      if (!Number.isFinite(n) || n <= 0) return null;

      const unit = unitOf(s) || fallbackUnit;
      if (unit === 'cr') return n * 100;          // crore → lakhs
      if (unit === 'l') return n;                 // already lakhs
      // No unit anywhere: decide by magnitude.
      return n >= RUPEE_THRESHOLD ? n / RUPEE_THRESHOLD : n;
    };

    const first = valueOf(sides[0]);
    const second = sides.length > 1 ? valueOf(sides[1]) : null;

    if (first == null) return empty;
    if (second == null) return { budget: first, budgetMax: null };

    // Tolerate a reversed range rather than rejecting it.
    return {
      budget: Math.min(first, second),
      budgetMax: Math.max(first, second),
    };
  }

  /**
   * Parse a monthly rent into plain RUPEES.
   *
   *   "25000"    → 25000
   *   "25k"      → 25000
   *   "₹25,000"  → 25000
   *   "25000/mo" → 25000
   *
   * Kept separate from parseBudget on purpose: a rent figure is a monthly rupee
   * amount, not lakhs. Running it through parseBudget would read 25000 as
   * 25,000 lakhs (₹250 crore).
   */
  parseMonthlyRent(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;

    const text = String(raw).toLowerCase().replace(/[₹,\s]/g, '');
    if (!text) return null;

    const m = text.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    let n = Number(m[0]);
    if (!Number.isFinite(n) || n <= 0) return null;

    // Check lakh/lac BEFORE the "k" shorthand — "lakh" contains a k, so testing
    // /k/ first would read "1.5 lakh" as 1,500.
    if (/lakh|lac/.test(text)) n *= 100000;
    else if (/k/.test(text)) n *= 1000;              // "25k"

    return Math.round(n);
  }

  /**
   * Split a home-type label into { bhkType, propertyType }.
   *
   *   "2 BHK"      → { bhkType: '2BHK', propertyType: 'flat' }
   *   "5 BHK+"     → { bhkType: '5BHK', propertyType: 'flat' }
   *   "Villa"      → { bhkType: null,   propertyType: 'villa' }
   *   "Plot"       → { bhkType: null,   propertyType: 'plot' }
   *   "3 BHK Villa"→ { bhkType: '3BHK', propertyType: 'villa' }
   *
   * A BHK count with no type word implies a flat — that is the overwhelmingly
   * common case and leaving propertyType null would make the engine score type
   * as "neutral", which lets flats and plots rank against each other.
   */
  parseHomeType(raw) {
    const empty = { bhkType: null, propertyType: null };
    if (!raw) return empty;

    const text = String(raw).toLowerCase().trim();
    if (!text) return empty;

    const bhkMatch = text.match(/(\d+)\s*(?:bhk|bedroom|bed)/);
    const bhkType = bhkMatch ? `${bhkMatch[1]}BHK` : null;

    // Whatever is left after removing the BHK count describes the type.
    const remainder = text.replace(/(\d+)\s*(?:bhk|bedroom|bed)\+?/, ' ').trim();

    let propertyType = null;
    if (remainder) {
      const norm = propertyTypeNormalizer.normalize(remainder);
      // Prefer the canonical family; keep the raw label if the normalizer can't
      // place it, since the engine runs it through the same normalizer anyway.
      propertyType = norm.family || (remainder.length > 1 ? remainder : null);
    }
    if (!propertyType && bhkType) propertyType = 'flat';

    return { bhkType, propertyType };
  }

  /**
   * Split a combined location string into { locationRaw, city }.
   *
   * "Besa, Nagpur"  → { locationRaw: 'Besa', city: 'Nagpur' }
   * "Nagpur"        → { locationRaw: null,   city: 'Nagpur' }
   *
   * A single token is treated as a CITY, not a locality, and locationRaw is
   * left null on purpose. Claiming a locality the agent never gave would make
   * reverse matching apply its "named a location that didn't match" penalty to
   * every project in the city.
   *
   * This is a legacy-backfill helper. New leads collect city and locality as
   * separate inputs, so nothing has to be guessed.
   */
  splitLocation(raw) {
    const empty = { locationRaw: null, city: null };
    if (!raw) return empty;

    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return empty;
    if (parts.length === 1) return { locationRaw: null, city: parts[0] };

    return {
      locationRaw: parts.slice(0, -1).join(', '),
      city: parts[parts.length - 1],
    };
  }

  // ─── Write path ───────────────────────────────────────────────────────────

  /**
   * Sanitise and normalise a requirements payload before it is stored.
   * Called by the controller so units are fixed server-side rather than trusted
   * from the client.
   *
   * - budget/budgetMax accept a number or free text, and are stored in lakhs
   * - area is stored in SQFT, with the agent's original value/unit preserved
   *   in areaInput/areaUnit for display and edit round-trips
   * - locationCanonical is derived so the engine can do canonical comparison
   */
  normalizeRequirements(input = {}) {
    const out = {};

    const isRent = input.transactionType === 'rent';
    if (input.transactionType === 'buy' || isRent) {
      out.transactionType = input.transactionType;
    }

    if (isRent) {
      // Rent budgets are monthly rupees and go in their own field. `budget` /
      // `budgetMax` are lakhs and stay null so the two are never confused.
      const rent = this.parseMonthlyRent(
        input.rentBudgetMonthly != null && input.rentBudgetMonthly !== ''
          ? input.rentBudgetMonthly
          : input.budget
      );
      if (rent != null) out.rentBudgetMonthly = rent;
    } else {
      // Budget: an explicit budgetMax wins over one parsed out of a range string.
      const parsed = this.parseBudget(input.budget);
      if (parsed.budget != null) out.budget = parsed.budget;
      const explicitMax = this.parseBudget(input.budgetMax).budget;
      if (explicitMax != null) out.budgetMax = explicitMax;
      else if (parsed.budgetMax != null) out.budgetMax = parsed.budgetMax;
    }

    if (input.bhkType) {
      const m = String(input.bhkType).match(/\d+/);
      out.bhkType = m ? `${m[0]}BHK` : String(input.bhkType).trim();
    }

    if (input.propertyType) {
      const norm = propertyTypeNormalizer.normalize(input.propertyType);
      out.propertyType = norm.family || String(input.propertyType).trim().toLowerCase();
    }

    // Area → always sqft, original preserved.
    if (input.area != null && input.area !== '') {
      const unit = input.areaUnit === 'acres' ? 'acres' : 'sqft';
      const sqft = this.toSqft(input.area, unit);
      if (sqft != null) {
        out.area = sqft;
        out.areaUnit = unit;
        out.areaInput = Number(input.area);
      }
    }

    if (input.locationRaw) out.locationRaw = String(input.locationRaw).trim();
    if (input.city) out.city = String(input.city).trim();

    // Derive the canonical key from the most specific location we have.
    const locSource = out.locationRaw || out.city;
    if (locSource) {
      try {
        out.locationCanonical = locationNormalizer.normalize(locSource).canonical || null;
      } catch {
        out.locationCanonical = null;   // never block a write on normalisation
      }
    }

    // Verified-location passthrough (enables geo-proximity scoring).
    for (const key of ['placeId', 'formattedAddress', 'state', 'postalCode']) {
      if (input[key]) out[key] = String(input[key]).trim();
    }
    for (const key of ['latitude', 'longitude']) {
      const n = Number(input[key]);
      if (Number.isFinite(n) && n !== 0) out[key] = n;
    }

    if (input.possessionNeeded) out.possessionNeeded = String(input.possessionNeeded).trim();
    if (input.loanRequired !== undefined) out.loanRequired = !!input.loanRequired;

    return out;
  }

  // ─── Read path ────────────────────────────────────────────────────────────

  /**
   * Resolve a lead's effective requirements, filling gaps from the legacy
   * free-text fields so pre-existing leads are matchable without a migration.
   *
   * @returns {{ effective: object, derivedFrom: string[] }} `derivedFrom` lists
   *   the requirement keys that came from legacy text rather than structured
   *   input, so callers can surface "we inferred this, please confirm".
   */
  resolve(lead) {
    const r = (lead && lead.requirements) || {};
    const effective = {
      transactionType: r.transactionType || 'buy',
      bhkType: r.bhkType || null,
      propertyType: r.propertyType || null,
      budget: r.budget != null ? r.budget : null,
      budgetMax: r.budgetMax != null ? r.budgetMax : null,
      rentBudgetMonthly: r.rentBudgetMonthly != null ? r.rentBudgetMonthly : null,
      area: r.area != null ? r.area : null,
      locationRaw: r.locationRaw || null,
      city: r.city || null,
      locationCanonical: r.locationCanonical || null,
      latitude: r.latitude != null ? r.latitude : null,
      longitude: r.longitude != null ? r.longitude : null,
      possessionNeeded: r.possessionNeeded || null,
      loanRequired: !!r.loanRequired,
    };
    const derivedFrom = [];

    // Budget ← legacy free text. Which field it lands in depends on buy vs rent,
    // because the two are different quantities (lakhs vs rupees/month).
    if (lead && lead.budget) {
      if (effective.transactionType === 'rent') {
        if (effective.rentBudgetMonthly == null) {
          const rent = this.parseMonthlyRent(lead.budget);
          if (rent != null) {
            effective.rentBudgetMonthly = rent;
            derivedFrom.push('rentBudgetMonthly');
          }
        }
      } else if (effective.budget == null) {
        const p = this.parseBudget(lead.budget);
        if (p.budget != null) {
          effective.budget = p.budget;
          if (effective.budgetMax == null) effective.budgetMax = p.budgetMax;
          derivedFrom.push('budget');
        }
      }
    }

    // BHK / property type ← legacy homeType
    if ((!effective.bhkType || !effective.propertyType) && lead && lead.homeType) {
      const p = this.parseHomeType(lead.homeType);
      if (!effective.bhkType && p.bhkType) {
        effective.bhkType = p.bhkType;
        derivedFrom.push('bhkType');
      }
      if (!effective.propertyType && p.propertyType) {
        effective.propertyType = p.propertyType;
        derivedFrom.push('propertyType');
      }
    }

    // Locality / city ← legacy location
    if ((!effective.city || !effective.locationRaw) && lead && lead.location) {
      const p = this.splitLocation(lead.location);
      if (!effective.city && p.city) {
        effective.city = p.city;
        derivedFrom.push('city');
      }
      if (!effective.locationRaw && p.locationRaw) {
        effective.locationRaw = p.locationRaw;
        derivedFrom.push('locationRaw');
      }
    }

    // Canonical key, if we ended up with a location but no canonical form.
    if (!effective.locationCanonical) {
      const locSource = effective.locationRaw || effective.city;
      if (locSource) {
        try {
          effective.locationCanonical = locationNormalizer.normalize(locSource).canonical || null;
        } catch { /* non-fatal */ }
      }
    }

    return { effective, derivedFrom };
  }

  /**
   * Build the object handed to MatchEngineV2.findMatches().
   *
   * Field names here are exactly what the engine reads — see MatchEngineV2
   * `_buildQuery` and `_calculateScore`. `location` is set alongside
   * `locationRaw` because the engine prefers `locationRaw` but falls back to
   * `location`, and callers of the reverse scorer read `params.location`.
   */
  toRequirement(lead) {
    const { effective } = this.resolve(lead);
    return {
      budget: effective.budget,
      budgetMax: effective.budgetMax,
      locationRaw: effective.locationRaw,
      location: effective.locationCanonical || effective.locationRaw || effective.city,
      locationCanonical: effective.locationCanonical,
      city: effective.city,
      bhkType: effective.bhkType,
      propertyType: effective.propertyType,
      // Already normalised to sqft on write, so the engine's sqft assumption holds.
      area: effective.area,
      areaUnit: effective.area != null ? 'sqft' : null,
      latitude: effective.latitude,
      longitude: effective.longitude,
      possessionNeeded: effective.possessionNeeded,
      loanRequired: effective.loanRequired,
      // The engine ignores this today, but the reverse/cross scorers read it and
      // the match service uses it to decide whether to run at all.
      transactionType: effective.transactionType,
    };
  }

  /**
   * Does this lead carry enough information to produce trustworthy matches?
   *
   * The thresholds are derived from how the engine scores, not picked at random.
   * With a 45-point notification bar and budget/location worth 28 each, a lead
   * missing both cannot legitimately qualify — but it CAN still accumulate
   * ~9-11 points of neutral/free credit, which is exactly how a "match" that
   * matches nothing gets shown to an agent. So:
   *
   *   budget      required — otherwise price is unbounded
   *   city        required — otherwise the lead matches any city
   *   propertyType required — the engine scores a missing type as neutral,
   *                which lets a plot buyer rank against flats
   *   bhkType     required for built-up types (the engine skips BHK for land)
   *   area        required for land types, where BHK is skipped and area is the
   *               only real discriminator
   *
   * A rent lead is checked against `rentBudgetMonthly` instead of `budget`, so
   * an agent is never blocked from qualifying one. Whether a lead is actually
   * matched is a separate decision made by HumanLeadMatchService — rent is
   * currently captured but not matched.
   *
   * @returns {{ ok: boolean, missing: string[], effective: object, derivedFrom: string[] }}
   */
  isMatchable(lead) {
    const { effective, derivedFrom } = this.resolve(lead);
    const missing = [];

    if (effective.transactionType === 'rent') {
      if (effective.rentBudgetMonthly == null || effective.rentBudgetMonthly <= 0) {
        missing.push('rentBudgetMonthly');
      }
    } else if (effective.budget == null || effective.budget <= 0) {
      missing.push('budget');
    }

    if (!effective.city) missing.push('city');
    if (!effective.propertyType) missing.push('propertyType');

    const isLand = effective.propertyType
      ? propertyTypeNormalizer.isLandType(effective.propertyType)
      : false;

    if (isLand) {
      if (effective.area == null || effective.area <= 0) missing.push('area');
    } else if (effective.propertyType) {
      if (!effective.bhkType) missing.push('bhkType');
    }

    return { ok: missing.length === 0, missing, effective, derivedFrom };
  }
}

module.exports = new LeadRequirementMapper();
module.exports.LeadRequirementMapper = LeadRequirementMapper;
module.exports.SQFT_PER_ACRE = SQFT_PER_ACRE;
