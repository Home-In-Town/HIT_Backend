/**
 * LeadFlowEngine
 *
 * The deterministic Question Engine for AI Lead Matching (Approach A).
 *
 * This module is INTENTIONALLY PURE:
 *   - no database access
 *   - no I/O, no side effects
 *   - given the slot schema, the intent, and the currently filled slots,
 *     it decides the next question, validates answers, reports completion,
 *     and maps the collected slots into an ExtractedLead-shaped params object.
 *
 * Location normalization is NOT done here (it requires the LocationNormalizer
 * service); the controller injects the normalized value before/after calling
 * the engine. Keeping the engine pure makes branching/termination trivially
 * unit-testable.
 */

const schema = require('../config/leadSlotSchema');

const PHONE_RE = /^[6-9]\d{9}$/;

class LeadFlowEngine {
  constructor(slotSchema = schema) {
    this.schema = slotSchema;
  }

  /**
   * The full intent list.
   */
  intents() {
    return this.schema.INTENTS.slice();
  }

  /**
   * Get a slot definition by id.
   */
  getSlot(slotId) {
    return this.schema.slotsById[slotId] || null;
  }

  /**
   * Resolve the question text for a slot given the current intent.
   * Prefers slot.questionByIntent[intent], falls back to slot.question.
   * Returns { en, hi }.
   */
  questionFor(slot, intent) {
    if (!slot) return { en: '', hi: '' };
    if (intent && slot.questionByIntent && slot.questionByIntent[intent]) {
      return slot.questionByIntent[intent];
    }
    return slot.question || { en: '', hi: '' };
  }

  /**
   * Does a slot apply given the current intent and filled slots?
   * A slot applies when:
   *   - its `appliesToIntent` (if set) includes the intent, AND
   *   - its `branchIf` (if set) is satisfied by the filled slots.
   */
  slotApplies(slot, intent, filledSlots) {
    if (!slot) return false;

    if (Array.isArray(slot.appliesToIntent) && slot.appliesToIntent.length > 0) {
      if (!slot.appliesToIntent.includes(intent)) return false;
    }

    if (slot.branchIf && typeof slot.branchIf === 'object') {
      for (const [depId, expected] of Object.entries(slot.branchIf)) {
        const actual = filledSlots ? filledSlots[depId] : undefined;
        const allowed = Array.isArray(expected) ? expected : [expected];
        if (!allowed.includes(actual)) return false;
      }
    }

    return true;
  }

  /**
   * Ordered list of slots applicable for the current intent + filled slots.
   * The `intent` slot itself is always applicable and first.
   */
  applicableSlots(intent, filledSlots = {}) {
    return this.schema.slots.filter((slot) => {
      if (slot.id === 'intent') return true;
      // Non-intent slots require an intent to be chosen first.
      if (!intent) return false;
      return this.slotApplies(slot, intent, filledSlots);
    });
  }

  /**
   * The next unfilled REQUIRED slot to ask, or null when all required
   * applicable slots are filled. Optional slots are asked too (they appear
   * in the applicable list), but they never *block* completion.
   *
   * We ask slots in schema order: the first applicable slot that has no value
   * yet is returned (required or optional). Completion (isComplete) only
   * depends on required slots.
   */
  nextSlot(intent, filledSlots = {}) {
    const applicable = this.applicableSlots(intent, filledSlots);
    for (const slot of applicable) {
      const hasValue = filledSlots[slot.id] !== undefined && filledSlots[slot.id] !== null && filledSlots[slot.id] !== '';
      if (!hasValue) return slot;
    }
    return null;
  }

  /**
   * True when every required applicable slot has a value.
   */
  isComplete(intent, filledSlots = {}) {
    if (!intent) return false;
    const applicable = this.applicableSlots(intent, filledSlots);
    for (const slot of applicable) {
      if (!slot.required) continue;
      const v = filledSlots[slot.id];
      if (v === undefined || v === null || v === '') return false;
    }
    return true;
  }

  /**
   * Does a slot POTENTIALLY apply — used to estimate progress total before all
   * branch dependencies are answered. A branchable slot counts as "possible"
   * when its dependency is either satisfied OR not yet answered.
   */
  slotMayApply(slot, intent, filledSlots) {
    if (!slot) return false;
    if (Array.isArray(slot.appliesToIntent) && slot.appliesToIntent.length > 0) {
      if (!slot.appliesToIntent.includes(intent)) return false;
    }
    if (slot.branchIf && typeof slot.branchIf === 'object') {
      for (const [depId, expected] of Object.entries(slot.branchIf)) {
        const actual = filledSlots ? filledSlots[depId] : undefined;
        // Dependency answered and does NOT match → definitely excluded.
        if (actual !== undefined && actual !== null && actual !== '') {
          const allowed = Array.isArray(expected) ? expected : [expected];
          if (!allowed.includes(actual)) return false;
        }
        // Dependency not answered yet → optimistically counts as possible.
      }
    }
    return true;
  }

  /**
   * Estimated total number of questions for the intent, counting slots that
   * may still apply. Used for the "Sawal X/Y" progress hint so Y is stable and
   * realistic even before branch dependencies are answered.
   */
  estimatedTotal(intent, filledSlots = {}) {
    if (!intent) {
      // Before intent is chosen, estimate using the intent slot's schema:
      // count the intent slot plus every slot not gated by an unmatched branch.
      return this.schema.slots.filter((s) =>
        s.id === 'intent' || (!Array.isArray(s.appliesToIntent) && this._noHardExclusion(s))
      ).length;
    }
    return this.schema.slots.filter((slot) => {
      if (slot.id === 'intent') return true;
      return this.slotMayApply(slot, intent, filledSlots);
    }).length;
  }

  // A slot has no hard exclusion when it has no branchIf, or its branchIf
  // dependency isn't answered yet (used only for the pre-intent estimate).
  _noHardExclusion(slot) {
    return true;
  }

  /**
   * Progress hint for the UI: 1-based index of the current slot within the
   * applicable slot list, plus the estimated total question count.
   */
  progress(intent, filledSlots, currentSlotId) {
    const applicable = this.applicableSlots(intent, filledSlots);
    const total = Math.max(this.estimatedTotal(intent, filledSlots), applicable.length);
    const idx = applicable.findIndex((s) => s.id === currentSlotId);
    return { current: idx >= 0 ? idx + 1 : total, total };
  }

  /**
   * Validate & coerce a raw answer for a slot.
   * Returns { valid, value?, hint? }.
   *
   * For 'location', we accept any non-empty string here (normalization is done
   * by the controller via LocationNormalizer). The returned value is the raw text.
   *
   * For 'number', `raw` may be a number, a numeric string, or an object
   * { value, unit } when the slot has a unit toggle. On success, value is
   * { amount, unit } for unit slots, or a plain number otherwise.
   */
  parseAndValidate(slot, raw) {
    if (!slot) return { valid: false, hint: 'Unknown question.' };

    switch (slot.inputType) {
      case 'choice': {
        const allowed = (slot.options || []).map((o) => o.value);
        if (allowed.includes(raw)) return { valid: true, value: raw };
        return {
          valid: false,
          hint: 'Please choose one of the given options.'
        };
      }

      case 'number': {
        let amount = raw;
        let unit = null;
        if (raw && typeof raw === 'object') {
          amount = raw.value !== undefined ? raw.value : raw.amount;
          unit = raw.unit || null;
        }
        const num = typeof amount === 'string' ? Number(amount.trim()) : amount;
        if (num === null || num === undefined || Number.isNaN(num)) {
          return { valid: false, hint: 'Please enter a valid number.' };
        }
        if (typeof slot.min === 'number' && num < slot.min) {
          return { valid: false, hint: `Value must be at least ${slot.min}.` };
        }
        if (typeof slot.max === 'number' && num > slot.max) {
          return { valid: false, hint: `Value must be at most ${slot.max}.` };
        }
        // Validate unit against the slot's unit list when present.
        if (Array.isArray(slot.unit) && slot.unit.length > 0) {
          const chosenUnit = unit || slot.unit[0];
          if (!slot.unit.includes(chosenUnit)) {
            return { valid: false, hint: 'Please choose a valid unit.' };
          }
          return { valid: true, value: { amount: num, unit: chosenUnit } };
        }
        return { valid: true, value: num };
      }

      case 'phone': {
        const digits = String(raw || '').replace(/\D/g, '').slice(-10);
        if (PHONE_RE.test(digits)) return { valid: true, value: digits };
        return { valid: false, hint: 'Please enter a valid 10-digit mobile number.' };
      }

      case 'location':
      case 'text':
      default: {
        const text = String(raw || '').trim();
        if (!text) return { valid: false, hint: 'This field cannot be empty.' };
        return { valid: true, value: text };
      }
    }
  }

  /**
   * When a slot value changes (edit), drop values for slots that no longer
   * apply under the new filled-slots state. Returns a NEW filled-slots object.
   * (e.g., changing propertyType from 'flat' to 'plot' drops 'bhk'.)
   */
  pruneInapplicable(intent, filledSlots = {}) {
    const pruned = { ...filledSlots };
    for (const slot of this.schema.slots) {
      if (slot.id === 'intent') continue;
      if (pruned[slot.id] === undefined) continue;
      if (!this.slotApplies(slot, intent, pruned)) {
        delete pruned[slot.id];
      }
    }
    return pruned;
  }

  /**
   * Map filled slots into the ExtractedLead shape.
   * Returns { direction, transactionType, params }.
   *
   * `slots.area` / `slots.expectedPrice` may be { amount, unit } (from a
   * unit-toggle number input) or a plain number.
   */
  buildLeadParams(intent, filledSlots = {}) {
    const direction = intent; // 'sell' | 'buy' | 'rent'
    const transactionType = intent === 'rent' ? 'rent' : 'buy'; // preserve existing enum

    const area = this._numberAndUnit(filledSlots.area);
    const price = this._numberAndUnit(filledSlots.expectedPrice);

    // Normalize price to lakhs for the existing budget/expectedPrice fields.
    let priceLakhs = price.amount;
    if (price.unit === 'cr') priceLakhs = price.amount * 100;

    // Normalize area unit to the ExtractedLead enum ['sqft','acres',null].
    let areaUnit = null;
    if (area.unit === 'sqft' || area.unit === 'acres') areaUnit = area.unit;

    const params = {
      bhkType: filledSlots.bhk || null,
      // For a sell/rent listing the "budget" concept is the asking price.
      budget: priceLakhs != null ? priceLakhs : null,
      budgetMax: null,
      expectedPrice: priceLakhs != null ? priceLakhs : null,
      location: filledSlots.location || null,
      locationRaw: filledSlots.location || null,
      locationCanonical: null, // controller fills via LocationNormalizer
      city: filledSlots.city || null,
      propertyType: filledSlots.propertyType || null,
      transactionType,
      area: area.amount != null ? area.amount : null,
      areaUnit,
      possessionNeeded: filledSlots.possession || null,
      loanRequired: false,
      urgency: filledSlots.urgency || 'normal'
    };

    return { direction, transactionType, params };
  }

  /**
   * Human-readable recap for the Summary Card and the ExtractedLead.originalText.
   * Returns { text, values } where values is an ordered list for the UI.
   */
  buildSummary(intent, filledSlots = {}) {
    const values = [];
    const applicable = this.applicableSlots(intent, filledSlots);
    for (const slot of applicable) {
      const raw = filledSlots[slot.id];
      if (raw === undefined || raw === null || raw === '') continue;
      values.push({
        slotId: slot.id,
        label: slot.question.en,
        display: this._displayValue(slot, raw)
      });
    }
    const text = values.map((v) => v.display).join(' • ');
    return { text: text || 'Lead', values };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  _numberAndUnit(v) {
    if (v && typeof v === 'object') {
      return { amount: v.amount != null ? v.amount : (v.value != null ? v.value : null), unit: v.unit || null };
    }
    if (typeof v === 'number') return { amount: v, unit: null };
    return { amount: null, unit: null };
  }

  _displayValue(slot, raw) {
    if (slot.inputType === 'choice') {
      const opt = (slot.options || []).find((o) => o.value === raw);
      return opt ? opt.label.en : String(raw);
    }
    if (slot.inputType === 'number') {
      const { amount, unit } = this._numberAndUnit(raw);
      return unit ? `${amount} ${unit}` : `${amount}`;
    }
    return String(raw);
  }
}

module.exports = new LeadFlowEngine();
module.exports.LeadFlowEngine = LeadFlowEngine; // export class for testing
