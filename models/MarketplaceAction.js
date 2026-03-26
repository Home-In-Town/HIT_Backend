const mongoose = require('mongoose');

const marketplaceActionSchema = new mongoose.Schema({
  // Which listing was acted on
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MarketplaceListing',
    required: true,
    index: true
  },
  // Who performed the action
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Type of action taken
  actionType: {
    type: String,
    enum: [
      'viewed',         // Builder/agent viewed the listing
      'inquired',       // Sent inquiry / started chat about it
      'shared',         // Shared the listing with a client
      'claimed',        // Claimed the listing as a referral
      'deal_closed',    // Deal was closed via this referral
      'deal_failed'     // Deal attempt failed
    ],
    required: true,
    index: true
  },
  // Commission calculation fields
  commission: {
    type: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    value: { type: Number, default: 0 },
    baseValue: { type: Number, default: 0 },
    earnedAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'paid', 'rejected'],
      default: 'pending'
    }
  },
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Notes about this action
  notes: { type: String, default: '' }
}, {
  timestamps: true
});

// Compound indexes for commission tracking
marketplaceActionSchema.index({ listing: 1, actor: 1, actionType: 1 });
marketplaceActionSchema.index({ actor: 1, 'commission.status': 1 });

module.exports = mongoose.model('MarketplaceAction', marketplaceActionSchema);
