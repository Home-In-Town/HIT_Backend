const mongoose = require('mongoose');

// Pipeline stages used by the Human Lead Manager
const STAGES = [
  'New Lead',
  'Contacted',
  'Qualified',
  'Site Visit Scheduled',
  'Site Visit Done',
  'Negotiation',
  'Booking',
  'Won',
  'Lost',
];

// The stage at which a lead becomes eligible for property matching. Reaching
// this stage is what flips `matchingEnabled` on and triggers the first match run.
const QUALIFIED_STAGE = 'Qualified';

const stageHistorySchema = new mongoose.Schema({
  from: { type: String },
  to: { type: String, required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * Structured, machine-matchable requirements for a manually created CRM lead.
 *
 * WHY THIS EXISTS
 * The legacy top-level fields (`budget`, `homeType`, `location`) are free text
 * typed by an agent — "50-60L", "2 BHK", "Besa, Nagpur". MatchEngineV2 cannot
 * consume any of that: it needs a budget as a NUMBER IN LAKHS, a bhkType like
 * "2BHK", and locality/city as SEPARATE fields. So a CRM lead could never be
 * matched at all.
 *
 * Field names here deliberately MIRROR `ExtractedLead.params` one-for-one, so
 * LeadRequirementMapper is a near pass-through and there is no naming drift
 * between the chat-captured and human-captured lead paths. Both end up feeding
 * the same engine.
 *
 * UNITS — these are the two things that silently break matching, so they are
 * normalised on write and documented here:
 *   budget / budgetMax : LAKHS   (₹50,00,000 is stored as 50)
 *   area               : SQFT    (always; see areaUnit/areaInput below)
 */
const leadRequirementsSchema = new mongoose.Schema({
  // Buy vs rent. NOTE: MatchEngineV2 does not read this field, and Project has
  // no sale/rent distinction at all, so rent leads are currently captured but
  // NOT matched (HumanLeadMatchService skips them and records a reason). Kept
  // here so the data is correct the day rent inventory is supported.
  transactionType: { type: String, enum: ['buy', 'rent'], default: 'buy' },

  // "2BHK" / "3BHK". Parsed numerically by the engine, so "2 BHK" also works,
  // but write the canonical form.
  bhkType: { type: String, default: null },

  // Free-text label: flat, plot, villa, farm, shop, office, warehouse, ...
  // Resolved through PropertyTypeNormalizer, so rich labels are fine.
  propertyType: { type: String, default: null },

  // ── Budget, in LAKHS (sale only) ──
  // Only meaningful when transactionType is 'buy'. A rent budget is a monthly
  // rupee amount, which is a different quantity entirely — storing "25000"
  // (₹25k/month) here would read as 25,000 lakhs = ₹250 crore. Rent therefore
  // gets its own field below rather than corrupting this one.
  budget: { type: Number, default: null },
  budgetMax: { type: Number, default: null },

  // ── Rent budget, in RUPEES PER MONTH (rent only) ──
  // Captured now so the data is correct from day one. Rent is not matched yet
  // (Project has no sale/rent distinction), so nothing reads this — but when
  // rent inventory is supported no backfill will be needed.
  rentBudgetMonthly: { type: Number, default: null },

  // ── Area ──
  // `area` is ALWAYS sqft so it can be handed to the engine untouched.
  // `areaUnit` + `areaInput` preserve what the agent actually typed so the UI
  // can render "2 acres" instead of "87120 sqft" and edits round-trip cleanly.
  area: { type: Number, default: null },
  areaUnit: { type: String, enum: ['sqft', 'acres', null], default: null },
  areaInput: { type: Number, default: null },

  // ── Location ──
  // Split deliberately: the engine scores locality and city separately, and
  // falls back to city when the locality does not match.
  locationRaw: { type: String, default: null },
  city: { type: String, default: null },
  locationCanonical: { type: String, default: null },

  // Verified location (Google Places). Coordinates unlock geo-proximity
  // scoring in the engine, which is far more reliable than string matching.
  placeId: { type: String, default: null },
  formattedAddress: { type: String, default: null },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  state: { type: String, default: null },
  postalCode: { type: String, default: null },

  // Possession timeline. These values are exactly the keys the engine's
  // possession map understands (both the NLP and AI-chat vocabularies), so no
  // translation is needed anywhere.
  possessionNeeded: {
    type: String,
    enum: ['immediate', '6months', '1year', '2year', 'ready', 'under_construction', null],
    default: null,
  },

  loanRequired: { type: Boolean, default: false },
}, { _id: false });

// Requirement keys a client is allowed to send. Exported so the controller can
// whitelist the payload instead of trusting the request body.
const REQUIREMENT_FIELDS = Object.keys(leadRequirementsSchema.obj);

const humanLeadSchema = new mongoose.Schema({
  // ── Lead details ──
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  altPhone: { type: String, trim: true },
  email: { type: String, trim: true },

  // ── Legacy free-text fields ──
  // Display-only. Superseded by `requirements` for anything machine-readable,
  // but left untouched so existing leads, the list UI and search keep working.
  budget: { type: String, trim: true },
  homeType: { type: String, trim: true },
  buyingType: { type: String, trim: true },
  location: { type: String, trim: true },

  projectName: { type: String, trim: true },   // stored by name (matches UI project pills)
  source: { type: String, trim: true, default: 'Manual' },

  // inbound = client's own enquiry, outbound = cold / manually sourced
  leadType: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },

  stage: { type: String, enum: STAGES, default: 'New Lead', index: true },

  // Site visit scheduling
  siteVisitDate: { type: String },   // ISO date string (YYYY-MM-DD)
  siteVisitTime: { type: String },   // e.g. "11:00 AM"

  // ── Structured requirements (property matching) ──
  requirements: { type: leadRequirementsSchema, default: () => ({}) },

  // ── Qualification / matching state ──
  // Set when the lead reaches the Qualified stage.
  qualifiedAt: { type: Date, default: null },
  qualifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Master switch for matching. Only qualified leads are matched, and only
  // qualified leads are scanned when a new project is published later — this is
  // what makes "no match today, matched automatically tomorrow" work.
  matchingEnabled: { type: Boolean, default: false },

  // Why matching did not run, when it didn't (e.g. 'rent_not_supported',
  // 'incomplete_requirements'). Null when matching ran normally.
  matchingSkippedReason: { type: String, default: null },

  // Summary of the latest match run. The authoritative per-pair records live in
  // the LeadPropertyMatch collection; these are denormalised for list badges.
  lastMatchRunAt: { type: Date, default: null },
  matchCount: { type: Number, default: 0 },
  bestMatchScore: { type: Number, default: 0 },

  // ── Ownership / visibility ──
  // Who brought/created the lead
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // The captain who owns the team this lead belongs to (null for admin-created with no team)
  owningCaptain: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  // The agent (or captain) this lead is currently assigned to
  assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  stageHistory: [stageHistorySchema],
  archived: { type: Boolean, default: false },
}, {
  timestamps: true,
});

// Common query patterns
humanLeadSchema.index({ owningCaptain: 1, archived: 1, createdAt: -1 });
humanLeadSchema.index({ createdBy: 1, createdAt: -1 });
humanLeadSchema.index({ assignedAgent: 1, createdAt: -1 });

// Reverse matching: when a project is published we scan for qualified leads,
// narrowed by city. Without this the scan is a full collection scan on every
// publish — the same mistake that made the ExtractedLead lookback expensive.
humanLeadSchema.index({ matchingEnabled: 1, archived: 1, 'requirements.city': 1, updatedAt: -1 });

humanLeadSchema.statics.STAGES = STAGES;
humanLeadSchema.statics.QUALIFIED_STAGE = QUALIFIED_STAGE;
humanLeadSchema.statics.REQUIREMENT_FIELDS = REQUIREMENT_FIELDS;

module.exports = mongoose.model('HumanLead', humanLeadSchema);
module.exports.STAGES = STAGES;
module.exports.QUALIFIED_STAGE = QUALIFIED_STAGE;
module.exports.REQUIREMENT_FIELDS = REQUIREMENT_FIELDS;
