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
        enum: ['admin', 'builder', 'agent', 'unassigned', 'user', 'employee', 'captain'],
        required: true,
        default: 'unassigned'
    },
    employerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isEmployerConfirmed: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    companyName: { type: String }, // Optional: Used by Builders / Captains

    // Captain-specific fields
    businessLogoUrl: { type: String },
    businessAddress: { type: String },
    businessCity: { type: String },
    businessState: { type: String },
    businessPinCode: { type: String },

    oldId: { type: String }, // For backward compatibility with legacy IDs
    builderCode: { type: String }, // Alternative ID for builder portfolio links

    // CRM Integration fields
    oneEmployeeLinked:  { type: Boolean, default: false },
    oneEmployeeOwnerId: { type: String, sparse: true },
    verificationStatus: {
        builder: { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified' },
        agent:   { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified' }
    },
    commissionHistory: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, {
    timestamps: true
});

// Index for quick lookups
userSchema.index({ role: 1 });
userSchema.index({ oldId: 1 });
userSchema.index({ builderCode: 1 });
userSchema.index({ oneEmployeeOwnerId: 1 }, { unique: true, sparse: true });

// Virtual: true when the builder verification is confirmed
userSchema.virtual('isVerifiedBuilder').get(function () {
    return this.verificationStatus?.builder === 'verified';
});

// Virtual: true when the agent verification is confirmed
userSchema.virtual('isVerifiedAgent').get(function () {
    return this.verificationStatus?.agent === 'verified';
});

module.exports = mongoose.model('User', userSchema);
