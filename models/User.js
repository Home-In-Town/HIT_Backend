const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String }, // Optional
    phone: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    mpin: { type: String }, // Hashed
    role: {
        type: String,
        enum: ['admin', 'builder', 'agent', 'unassigned', 'user'],
        required: true,
        default: 'unassigned'
    },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    companyName: { type: String }, // Optional: Used by Builders
    oldId: { type: String }, // For backward compatibility with legacy IDs
    builderCode: { type: String } // Alternative ID for builder portfolio links
}, {
    timestamps: true
});

// Index for quick lookups
userSchema.index({ role: 1 });
userSchema.index({ oldId: 1 });
userSchema.index({ builderCode: 1 });

module.exports = mongoose.model('User', userSchema);
