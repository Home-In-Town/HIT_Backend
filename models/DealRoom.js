const mongoose = require('mongoose');

const dealRoomSchema = new mongoose.Schema({
  // The agent who showed interest
  agent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // The builder whose inventory matched
  builder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // The matched project
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  // Reference to the original requirement message
  requirementMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GroupMessage',
    default: null
  },
  // Reference to the group room where the match happened
  groupRoom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GroupRoom',
    default: null
  },
  // Deal details
  clientBudget: { type: Number },       // what agent's client wants to spend (lakhs)
  projectPrice: { type: Number },       // builder's asking price (lakhs)
  commissionPercent: { type: Number, default: 0 },
  commissionAmount: { type: Number, default: 0 },

  // Deal status
  status: {
    type: String,
    enum: ['initiated', 'in_discussion', 'site_visit_scheduled', 'negotiation', 'closed_won', 'closed_lost'],
    default: 'initiated'
  },

  // Chat session between agent & builder for this deal
  chatSession: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatSession',
    default: null
  },

  // Notes / timeline
  notes: [{
    content: { type: String },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date, default: Date.now }
  }],

  statusHistory: [{
    from: String,
    to: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

dealRoomSchema.index({ agent: 1, status: 1 });
dealRoomSchema.index({ builder: 1, status: 1 });
dealRoomSchema.index({ project: 1 });

module.exports = mongoose.model('DealRoom', dealRoomSchema);
