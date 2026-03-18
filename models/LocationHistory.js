const mongoose = require('mongoose');

const locationHistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    placeName: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('LocationHistory', locationHistorySchema);
