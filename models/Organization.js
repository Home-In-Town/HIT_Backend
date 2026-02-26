const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true , trim: true},
    description: { type: String },

    // The Admin who created this organization
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    // Projects assigned to this organization
    projects: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project'
    }],

    // Agents who have access to this organization's projects
    agents: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],

    isActive: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Index for finding organizations by agent
organizationSchema.index({ agents: 1 });

module.exports = mongoose.model('Organization', organizationSchema);
