const mongoose = require('mongoose');

const stageHistorySchema = new mongoose.Schema({
  from: { type: String },
  to: { type: String, required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedAt: { type: Date, default: Date.now },
  notes: { type: String, default: '' }
}, { _id: false });

const crmLeadSchema = new mongoose.Schema({
  // The project this lead is associated with
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    index: true
  },
  // The user who owns/manages this lead
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // The lead contact (the builder/agent being tracked)
  leadContact: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Pipeline stage
  stage: {
    type: String,
    enum: ['New', 'Contacted', 'Qualified', 'Negotiation', 'Closed-Won', 'Closed-Lost'],
    default: 'New',
    index: true
  },
  // Priority level
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  // Lead source
  source: {
    type: String,
    enum: ['chat', 'marketplace', 'referral', 'manual', 'other'],
    default: 'manual'
  },
  // Estimated deal value
  estimatedValue: {
    type: Number,
    default: 0
  },
  // Follow-up reminders
  nextFollowUp: {
    type: Date,
    default: null
  },
  // Internal notes
  notes: [{
    content: { type: String, required: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date, default: Date.now }
  }],
  // Stage change history for audit trail
  stageHistory: [stageHistorySchema],
  // Tags for categorization
  tags: [{ type: String }],
  // Is lead archived
  archived: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Compound indexes for pipeline views
crmLeadSchema.index({ owner: 1, stage: 1 });
crmLeadSchema.index({ owner: 1, archived: 1, createdAt: -1 });

module.exports = mongoose.model('CrmLead', crmLeadSchema);
