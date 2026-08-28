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

const stageHistorySchema = new mongoose.Schema({
  from: { type: String },
  to: { type: String, required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

const humanLeadSchema = new mongoose.Schema({
  // ── Lead details ──
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  altPhone: { type: String, trim: true },
  email: { type: String, trim: true },
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

humanLeadSchema.statics.STAGES = STAGES;

module.exports = mongoose.model('HumanLead', humanLeadSchema);
