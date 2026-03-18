const mongoose = require('mongoose');

const meetingLogSchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    employerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    withWhom: { type: String, required: true },
    description: { type: String, required: true },
    location: {
        latitude: { type: Number },
        longitude: { type: Number },
        placeName: { type: String }
    },
    // Admin-Employee specific fields
    projectName: { type: String },
    projectLocation: { type: String },
    projectPrice: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('MeetingLog', meetingLogSchema);
