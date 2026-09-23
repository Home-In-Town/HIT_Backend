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
    enum: ['text', 'inventory_card', 'requirement_card', 'system', 'project_announcement'],
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

  // === Project Announcement Card ===
  // Broadcast into HIT Community when a project is published or significantly
  // edited. Stores a SNAPSHOT so the card renders stably even if the project is
  // later edited, unpublished, or deleted.
  projectAnnouncement: {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    kind: { type: String, enum: ['new', 'updated'], default: 'new' },
    // Project snapshot
    projectName: { type: String },
    coverImageUrl: { type: String },
    slug: { type: String },
    location: { type: String },
    city: { type: String },
    startingPrice: { type: Number },     // raw rupees
    bhkOptions: [String],
    projectStatus: { type: String },
    reraNumber: { type: String },
    bankLoanAvailable: { type: Boolean, default: false },
    // Builder identity snapshot
    builderName: { type: String },
    builderCompany: { type: String },
    isVerifiedBuilder: { type: Boolean, default: false },
    builderRating: { type: Number, default: 0 },
    // Only for kind: 'updated' — human-readable list of what changed
    changedFields: [String]
  },

  // Auto-match results stored on requirement cards
  matchResults: [{
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    score: { type: Number },  // match percentage 0-100
    matchedOn: [String]       // which criteria matched: ['budget', 'area', 'bhk', 'loan']
  }],

  // Marks THE single pinned property-details message of a project group.
  // The details message is updated in place whenever the project changes, so
  // the group always reflects the latest linked property without ever posting
  // a second copy. Exactly one per room (see the partial unique index below).
  isProjectDetails: { type: Boolean, default: false },

  deleted: { type: Boolean, default: false }
}, {
  timestamps: true
});

groupMessageSchema.index({ room: 1, createdAt: -1 });
groupMessageSchema.index({ 'requirementCard.area': 1 });
groupMessageSchema.index({ messageType: 1, room: 1 });

// Exactly one property-details message per room. Without this, a failed write
// followed by a later call would re-post the details (the old code inferred
// "is new" from the absence of any system message, which was fragile).
groupMessageSchema.index(
  { room: 1 },
  {
    unique: true,
    partialFilterExpression: { isProjectDetails: true },
    name: 'uniq_project_details_per_room'
  }
);

module.exports = mongoose.model('GroupMessage', groupMessageSchema);
