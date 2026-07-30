const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  // Who receives this notification
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Notification type for frontend routing
  type: {
    type: String,
    enum: [
      'lead_stage_change',     // CRM pipeline stage changed
      'lead_assigned',         // New lead was assigned
      'lead_follow_up',        // Follow-up reminder
      'new_chat_message',      // New chat message received
      'marketplace_action',    // Someone acted on your listing
      'commission_update',     // Commission status changed
      'new_listing',           // New marketplace listing matching criteria
      'lead_match',            // Auto-detected lead from chat with matching projects
      'system'                 // System notifications
    ],
    required: true
  },
  // Human-readable title
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  // Notification body
  message: {
    type: String,
    required: true,
    maxlength: 1000
  },
  // Reference to related entity
  reference: {
    model: { type: String, enum: ['CrmLead', 'ChatSession', 'MarketplaceListing', 'MarketplaceAction', 'Project', 'ExtractedLead'] },
    id: { type: mongoose.Schema.Types.ObjectId }
  },
  // Read status
  read: { type: Boolean, default: false },
  // Push notification sent?
  pushed: { type: Boolean, default: false }
}, {
  timestamps: true
});

// For fetching unread notifications efficiently
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
