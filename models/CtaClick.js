const mongoose = require('mongoose');

const ctaClickSchema = new mongoose.Schema({
  projectId: { type: String, required: true, index: true },
  visitId: { type: String, required: true },
  ctaType: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('CtaClick', ctaClickSchema);
