const mongoose = require('mongoose');

const shareTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  sharedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['link', 'pdf', 'qr'],
    required: true
  },
  // Track usage
  viewCount: { type: Number, default: 0 },
  lastViewedAt: { type: Date },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Compound index for quick lookups by project + sharer + type
shareTokenSchema.index({ project: 1, sharedBy: 1, type: 1 });

module.exports = mongoose.model('ShareToken', shareTokenSchema);
