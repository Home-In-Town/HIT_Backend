const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    role: {
        type: String,
        enum: ['admin', 'builder', 'agent'],
        required: true,
        default: 'agent'
    },
    companyName: { type: String }, // Optional: Used by Builders
    phone: { type: String },
    isActive: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Index for quick lookups
userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);
