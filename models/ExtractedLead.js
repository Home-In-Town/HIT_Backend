const mongoose = require('mongoose');

/**
 * ExtractedLead
 * 
 * Stores every lead auto-captured from chat/group-chat messages via NLP extraction.
 * Ensures NO data is lost — even low-confidence extractions are persisted for admin review.
 * 
 * Lifecycle: auto_detected → confirmed → converted (DealRoom created) OR rejected
 */

// How long a captured lead is retained. Must be >= the longest matching lookback
// (ReverseMatchService uses 180 days) or leads are deleted before they can be
// matched. Leads are the platform's core asset, so this is deliberately generous.
const LEAD_RETENTION_DAYS = 730; // 2 years

const matchResultSchema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  score: { type: Number },         // 0-100
  confidence: { type: Number },    // 0-1.0
  matchedOn: [String]              // ['budget', 'location_exact', 'bhk', ...]
}, { _id: false });

const extractedLeadSchema = new mongoose.Schema({
  // ─── Source Information ──────────────────────────────────────────────────
  source: {
    type: String,
    enum: ['group_chat', 'direct_chat'],
    required: true
  },
  // Reference to the original message
  sourceMessage: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'sourceMessageModel'
  },
  sourceMessageModel: {
    type: String,
    enum: ['GroupMessage', 'ChatMessage'],
    default: 'GroupMessage'
  },
  // The room/session where the message was sent
  sourceRoom: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'sourceRoomModel'
  },
  sourceRoomModel: {
    type: String,
    enum: ['GroupRoom', 'ChatSession'],
    default: 'GroupRoom'
  },
  // Original message text (for audit)
  originalText: {
    type: String,
    required: true,
    maxlength: 5000
  },

  // ─── Who Extracted ───────────────────────────────────────────────────────
  // The agent/captain who sent the message
  extractedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  extractedByRole: {
    type: String,
    enum: ['agent', 'captain', 'admin', 'builder'],
    default: 'agent'
  },

  // ─── Extracted Parameters ────────────────────────────────────────────────
  params: {
    bhkType: { type: String, default: null },       // "2BHK"
    budget: { type: Number, default: null },         // in lakhs
    budgetMax: { type: Number, default: null },      // max budget if range
    location: { type: String, default: null },       // canonical or cleaned
    locationRaw: { type: String, default: null },    // original text
    locationCanonical: { type: String, default: null }, // normalized canonical key
    city: { type: String, default: null },

    // ─── Verified location (Google Places) ───────────────────────────────────
    // Populated when the user picks a suggestion instead of free-typing. The
    // coordinates are what let a posted property render on the Project map and
    // enable geo-proximity scoring in MatchEngineV2.
    placeId: { type: String, default: null },
    formattedAddress: { type: String, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    propertyType: { type: String, default: null },   // flat, plot, villa, farm, farmhouse, shop, office, warehouse
    transactionType: { type: String, enum: ['buy', 'rent'], default: 'buy' }, // buy or rent/lease
    expectedPrice: { type: Number, default: null },   // seller's asking price (lakhs) — used for sell/rent listings
    area: { type: Number, default: null },            // area in sq.ft or acres
    areaUnit: { type: String, enum: ['sqft', 'acres', null], default: null },
    possessionNeeded: { type: String, default: null },
    loanRequired: { type: Boolean, default: false },
    // First three are the legacy NLP-derived values (still produced by
    // NLPExtractor from free text). The rest come from the AI chat's urgency
    // question. Both sets are accepted so old and new leads stay valid.
    urgency: {
      type: String,
      enum: ['normal', 'urgent', 'very_urgent', 'immediate', '1_2_months', 'exploring', 'other'],
      default: 'normal'
    },

    // ─── Sell-listing fields (from AI Lead Matching "sell" flow) ────────────
    // Mirror the project upload form so a seller lead carries listing detail.
    // All optional/nullable — buy/rent leads simply leave them null.
    category: { type: String, default: null },              // Residential | Commercial | Mixed Use
    projectStatus: { type: String, default: null },         // ready-to-move | under-construction | pre-launch
    reraApproved: { type: Boolean, default: null },
    reraNumber: { type: String, default: null },
    bankLoanAvailable: { type: Boolean, default: null },
    amenities: { type: [String], default: undefined },      // key amenities selected in chat

    // ─── "Other" free text ───────────────────────────────────────────────────
    // When a question is answered with the "Other" chip, the canonical value is
    // stored in its own field (e.g. projectStatus: 'other') and the user's exact
    // words are kept here, keyed by slot id:
    //   { projectStatus: 'Nearly done, 2 months left', bankLoanAvailable: 'Only SBI' }
    // Mixed/loose on purpose — the set of questions evolves, and this must never
    // reject a value and abort the lead save.
    otherDetails: { type: mongoose.Schema.Types.Mixed, default: undefined }
  },

  // ─── Lead Direction ──────────────────────────────────────────────────────
  // Captures whether the lead is a buyer, seller, or rental — richer than the
  // buy/rent transactionType enum (which cannot express "sell").
  // Defaults to 'buy' so all existing documents remain valid.
  direction: {
    type: String,
    enum: ['buy', 'sell', 'rent'],
    default: 'buy',
    index: true
  },

  // ─── Extraction Quality ──────────────────────────────────────────────────
  intent: {
    type: String,
    enum: ['requirement', 'implicit_requirement', 'follow_up_requirement', 'inventory'],
    default: 'requirement'
  },
  extractionConfidence: {
    type: Number,
    min: 0,
    max: 1,
    default: 0
  },
  paramCount: {
    type: Number,
    default: 0
  },

  // ─── Match Results ───────────────────────────────────────────────────────
  matches: [matchResultSchema],
  matchCount: { type: Number, default: 0 },
  bestMatchScore: { type: Number, default: 0 },

  // ─── Cross-Match Results (lead-to-lead matching) ─────────────────────────
  crossMatches: [{
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'ExtractedLead' },
    score: { type: Number },
    matchedOn: [String],
    matchType: { type: String, enum: ['inventory', 'requirement'] }
  }],
  crossMatchCount: { type: Number, default: 0 },
  bestCrossMatchScore: { type: Number, default: 0 },

  // ─── Lead Status ─────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['auto_detected', 'confirmed', 'rejected', 'converted', 'expired'],
    default: 'auto_detected',
    index: true
  },
  // If converted → link to the DealRoom
  convertedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DealRoom',
    default: null
  },

  // ─── Notification Tracking ───────────────────────────────────────────────
  adminNotified: { type: Boolean, default: false },
  adminNotifiedAt: { type: Date, default: null },
  notifiedAdmins: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  // ─── Expiry ──────────────────────────────────────────────────────────────
  // Retention was 15 days, which silently HARD-DELETED every lead two weeks
  // after capture. Two consequences:
  //   1. Buy requirements disappeared, so they could never be reused later.
  //   2. ReverseMatchService.LOOKBACK_DAYS = 180 was a no-op — nothing survived
  //      long enough to be found, so newly published projects were matched
  //      against an almost-empty pool of leads.
  // Leads are small documents and are the core asset of the CRM, so retention is
  // now measured in years. The TTL index is kept purely as long-tail housekeeping.
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  }
}, {
  timestamps: true
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
extractedLeadSchema.index({ extractedBy: 1, status: 1, createdAt: -1 });
extractedLeadSchema.index({ status: 1, createdAt: -1 });
extractedLeadSchema.index({ 'params.locationCanonical': 1 });
extractedLeadSchema.index({ source: 1, sourceRoom: 1 });
extractedLeadSchema.index({ extractionConfidence: -1 });
extractedLeadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index — long-tail housekeeping only
// Reverse/cross matching scans by direction + recency; without this the 180-day
// lookback did a collection scan on every project publish.
extractedLeadSchema.index({ direction: 1, createdAt: -1 });
extractedLeadSchema.index({ intent: 1, direction: 1, createdAt: -1 });

module.exports = mongoose.model('ExtractedLead', extractedLeadSchema);
module.exports.LEAD_RETENTION_DAYS = LEAD_RETENTION_DAYS;
