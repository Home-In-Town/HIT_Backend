const mongoose = require('mongoose');

/**
 * ExtractedLead
 * 
 * Stores every lead auto-captured from chat/group-chat messages via NLP extraction.
 * Ensures NO data is lost — even low-confidence extractions are persisted for admin review.
 * 
 * Lifecycle: auto_detected → confirmed → converted (DealRoom created) OR rejected
 */

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
    propertyType: { type: String, default: null },   // flat, plot, villa
    possessionNeeded: { type: String, default: null },
    loanRequired: { type: Boolean, default: false },
    urgency: { type: String, enum: ['normal', 'urgent', 'very_urgent'], default: 'normal' }
  },

  // ─── Extraction Quality ──────────────────────────────────────────────────
  intent: {
    type: String,
    enum: ['requirement', 'implicit_requirement'],
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
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
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
extractedLeadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index — auto-delete expired leads

module.exports = mongoose.model('ExtractedLead', extractedLeadSchema);
