const mongoose = require('mongoose');

const ctaClickEntrySchema = new mongoose.Schema({
    type:      { type: String },
    timestamp: { type: Date, default: Date.now },
    clickId:   { type: String }
}, { _id: false });

const projectVisitSchema = new mongoose.Schema({
    projectId: { type: String, required: true },
    ownerId:   { type: String, required: true },
    leadId:    { type: String },
    sessionId: { type: String },
    startTime: { type: Date, required: true },
    endTime:   { type: Date },
    duration:  { type: Number, default: 0 },
    device:    { type: String, enum: ['mobile', 'desktop', 'tablet', 'unknown'], default: 'unknown' },
    sections:  { type: [String], default: [] },
    ctaClicks: { type: [ctaClickEntrySchema], default: [] },
    source:    { type: String },
    referrer:  { type: String, maxlength: 2000 }
}, { timestamps: true });

// Single-field indexes
projectVisitSchema.index({ projectId: 1 });
projectVisitSchema.index({ ownerId: 1 });
projectVisitSchema.index({ leadId: 1 }, { sparse: true });
projectVisitSchema.index({ sessionId: 1 }, { unique: true, sparse: true });
projectVisitSchema.index({ startTime: 1 });

// Compound indexes
projectVisitSchema.index({ projectId: 1, startTime: -1 });
projectVisitSchema.index({ ownerId: 1, startTime: -1 });
projectVisitSchema.index({ leadId: 1, startTime: -1 }, { sparse: true });

module.exports = mongoose.model('ProjectVisit', projectVisitSchema);
