const mongoose = require('mongoose');

const visitSchema = new mongoose.Schema({
  projectId: { type: String, required: true, index: true },
  visitId: { type: String, required: true, unique: true },
  leadId: { type: String, index: true },
  duration: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Visit', visitSchema);
