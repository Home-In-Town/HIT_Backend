const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
  // Core identifiers
  callId: { type: String, required: true, unique: true },
  externalCallId: String, // Twilio SID

  // Links
  projectId: { type: String, index: true },
  agentId: String,
  clientId: String,

  // Call details
  // Call details
  toNumber: String,   // Recipient (to)
  fromNumber: String, // Caller (from)
  status: { type: String, default: 'initiated' },
  connectionId: String,

  // Timing
  startTime: Date,
  endTime: Date,
  duration: { type: Number, default: 0 },

  // AI Analysis (from Voice API)
  transcript: String,
  callSummary: mongoose.Schema.Types.Mixed,
  userAnalyticsSummary: mongoose.Schema.Types.Mixed,
  agentAnalyticsSummary: mongoose.Schema.Types.Mixed,
  conversationData: [mongoose.Schema.Types.Mixed],

  // Media
  recordingLink: String,

  // Campaign tracking
  batchCampaignId: String
}, {
  timestamps: true
});

module.exports = mongoose.model('CallLog', callLogSchema);
