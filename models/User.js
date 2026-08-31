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
    // Reserved non-human identity used as the sender of AI Lead Matching messages.
    // Excluded from contact/network listings. Absent/false for all real users.
    isSystemAssistant: { type: Boolean, default: false },
    companyName: { type: String }, // Optional: Used by Builders / Captains

    // Profile picture (all users)
    profilePictureUrl: { type: String },

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
    commissionHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // ── Referral / "Learn to Get Leads Faster" course ──
    referralCode: { type: String, unique: true, sparse: true, index: true }, // This user's own shareable code
    referredBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, // Who referred this user
    referredAt:   { type: Date, default: null },   // When this user joined via a referral
    courseUnlocked: { type: Boolean, default: false }, // Lead-generation course access

    // Presence & engagement
    lastSeen: { type: Date, default: null },

    // Builder rating (set by admin)
    rating: { type: Number, min: 0, max: 5, default: 0 },
    ratingCount: { type: Number, default: 0 } // How many ratings received
}, {
    timestamps: true
});

// Index for quick lookups
userSchema.index({ role: 1 });
userSchema.index({ oldId: 1 });
userSchema.index({ builderCode: 1 });
userSchema.index({ oneEmployeeOwnerId: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1, lastSeen: -1 }); // For builder network queries

// Virtual: true when the builder verification is confirmed
userSchema.virtual('isVerifiedBuilder').get(function () {
    return this.verificationStatus?.builder === 'verified';
});

// Virtual: true when the agent verification is confirmed
userSchema.virtual('isVerifiedAgent').get(function () {
    return this.verificationStatus?.agent === 'verified';
});

// Referral count for this user (how many people they've referred)
userSchema.index({ referredBy: 1, createdAt: -1 });

/**
 * Generate a unique, human-friendly referral code (e.g. "HIT-8F3K2Q").
 * Retries on the rare chance of a collision.
 */
userSchema.statics.generateUniqueReferralCode = async function () {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
    for (let attempt = 0; attempt < 6; attempt++) {
        let code = 'HIT-';
        for (let i = 0; i < 6; i++) {
            code += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        // eslint-disable-next-line no-await-in-loop
        const exists = await this.exists({ referralCode: code });
        if (!exists) return code;
    }
    // Fallback: timestamp-based, effectively collision-free
    return `HIT-${Date.now().toString(36).toUpperCase()}`;
};

module.exports = mongoose.model('User', userSchema);
