const mongoose = require('mongoose');

const groupMessageSchema = new mongoose.Schema({
  room: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GroupRoom',
    required: true,
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Message type determines how the message renders
  messageType: {
    type: String,
    enum: ['text', 'inventory_card', 'requirement_card', 'system'],
    default: 'text'
  },
  // Plain text content (for text/system messages)
  content: { type: String, default: '', maxlength: 5000 },

  // === Builder: Inventory Card ===
  inventoryCard: {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    bhkOptions: [String],
    priceRange: { min: Number, max: Number },
    area: { type: String },        // e.g., "Manish Nagar"
    city: { type: String },
    possessionStatus: { type: String },  // ready, 6months, 1year, 2year+
    bankLoanAvailable: { type: Boolean, default: false },
    commissionPercent: { type: Number, default: 0 },
    description: { type: String, default: '' }
  },

  // === Agent: Requirement Card ===
  requirementCard: {
    bhkType: { type: String },       // "2BHK", "3BHK", etc.
    budget: { type: Number },        // in lakhs
    area: { type: String },          // location/area name
    city: { type: String },
    possessionNeeded: { type: String }, // "immediate", "6months", "1year"
    loanRequired: { type: Boolean, default: false },
    urgency: { type: String, enum: ['normal', 'urgent', 'very_urgent'], default: 'normal' },
    clientNotes: { type: String, default: '' }
  },

  // Auto-match results stored on requirement cards
  matchResults: [{
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    score: { type: Number },  // match percentage 0-100
    matchedOn: [String]       // which criteria matched: ['budget', 'area', 'bhk', 'loan']
  }],

  deleted: { type: Boolean, default: false }
}, {
  timestamps: true
});

groupMessageSchema.index({ room: 1, createdAt: -1 });
groupMessageSchema.index({ 'requirementCard.area': 1 });
groupMessageSchema.index({ messageType: 1, room: 1 });

module.exports = mongoose.model('GroupMessage', groupMessageSchema);
