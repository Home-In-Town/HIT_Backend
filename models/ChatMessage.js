const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  session: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatSession',
    required: true,
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    type: String,
    required: true,
    maxlength: 5000
  },
  messageType: {
    type: String,
    enum: ['text', 'image', 'file', 'system'],
    default: 'text'
  },
  // File/image attachment metadata
  attachment: {
    url: { type: String },
    key: { type: String },
    filename: { type: String },
    size: { type: Number }
  },
  // AI Lead Matching: answer-template metadata for assistant (system) messages.
  // Tells the frontend which input control to render for the current question.
  // Absent for all normal chat messages.
  template: {
    slotId: { type: String },
    // 'choice' | 'number' | 'text' | 'location' | 'phone' | 'summary' | 'results'
    inputType: { type: String },
    options: { type: mongoose.Schema.Types.Mixed }, // choice options / summary values / match cards
    unit: [{ type: String }],
    // progress hint for the UI: current index (1-based) and total applicable slots
    progress: {
      current: { type: Number },
      total: { type: Number }
    }
  },
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  deleted: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Compound index for fetching messages in a session, sorted by time
chatMessageSchema.index({ session: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
