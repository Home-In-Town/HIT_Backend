const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  // Optional: link session to a specific project discussion
  projectContext: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    default: null
  },
  // Pre-chat qualification answers (INTERNAL ONLY - never exposed to other party)
  qualificationData: {
    initiator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    answers: {
      businessScale: {
        type: String,
        enum: ['small', 'average', 'large'],
        default: 'average'
      },
      reach: {
        type: String,
        enum: ['low', 'average', 'higher'],
        default: 'average'
      },
      domainCategory: { type: String, default: '' },
      yearsInBusiness: { type: Number, default: 0 },
      projectsCompleted: { type: Number, default: 0 }
    }
  },
  // ─── AI Lead Matching (Assistant Thread) ───────────────────────────────────
  // Marks this session as the persistent AI Assistant conversation for a user.
  // Absent/false for all normal 1:1 chat sessions.
  isAssistant: { type: Boolean, default: false, index: true },
  // Deterministic slot-filling conversation state. Only used when isAssistant.
  leadFlowState: {
    intent: { type: String, enum: ['sell', 'buy', 'rent', null], default: null },
    slots: { type: mongoose.Schema.Types.Mixed, default: {} }, // { slotId: value }
    currentSlotId: { type: String, default: null },
    // slotId currently being edited (re-open from summary); null when not editing
    editingSlotId: { type: String, default: null },
    status: {
      type: String,
      enum: ['in_progress', 'awaiting_confirmation', 'completed'],
      default: 'in_progress'
    }
  },
  lastMessage: {
    content: { type: String, default: '' },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now }
  },
  unreadCount: {
    type: Map,
    of: Number,
    default: {}
  },
  active: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Index for fast participant lookup
chatSessionSchema.index({ participants: 1 });
chatSessionSchema.index({ 'lastMessage.timestamp': -1 });

module.exports = mongoose.model('ChatSession', chatSessionSchema);
