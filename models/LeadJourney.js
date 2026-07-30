'use strict';

const mongoose = require('mongoose');

/**
 * LeadJourney — Tracks the property sales funnel for each lead.
 * Like e-commerce delivery tracking (Flipkart/Amazon) but for real estate.
 *
 * Stages:
 *   1. LEAD_CAPTURED     — Lead arrived from FB/Google/Manual/CSV
 *   2. CONTACTED         — AI call/WA/email sent (first touch)
 *   3. QUALIFIED         — Interest confirmed (HOT/WARM lead)
 *   4. SITE_VISIT_SCHEDULED — Visit date confirmed
 *   5. SITE_VISIT_DONE   — Actually visited the property
 *   6. OFFER_MADE        — Price discussion / offer sent
 *   7. NEGOTIATION       — Back and forth on terms
 *   8. DEAL_CLOSED       — Payment done / booking confirmed
 *   9. LOST              — Lead dropped / not interested / competitor won
 *
 * Each stage has: timestamp, notes, metadata, and who moved it.
 */

const journeyStageSchema = new mongoose.Schema({
    stage: {
        type: String,
        enum: [
            'lead_captured',
            'contacted',
            'qualified',
            'site_visit_scheduled',
            'site_visit_done',
            'offer_made',
            'negotiation',
            'deal_closed',
            'lost',
        ],
        required: true,
    },
    timestamp: { type: Date, default: Date.now },
    notes: { type: String, maxlength: 1000 },          // Agent's notes for this stage
    metadata: {
        // Stage-specific data
        callDuration: Number,                            // contacted: call duration in seconds
        visitDate: Date,                                 // site_visit_scheduled: when the visit is planned
        visitLocation: String,                           // site_visit_done: which project/property visited
        offerAmount: Number,                             // offer_made: amount offered (₹)
        dealAmount: Number,                              // deal_closed: final deal amount (₹)
        lostReason: String,                              // lost: why the lead dropped
        channel: String,                                 // contacted: 'voice_call' | 'whatsapp' | 'email'
        automationId: String,                            // automation job that triggered this stage
    },
    movedBy: {
        userId: String,                                  // Who moved this stage (HIT user or 'system')
        name: String,
        role: String,
    },
}, { _id: true });

const leadJourneySchema = new mongoose.Schema({
    // Link to OneEmployee lead
    leadId: { type: String, required: true, index: true },           // LeadGen Lead.id (UUID)
    ownerId: { type: String, required: true, index: true },          // OneEmployee Owner._id

    // Current stage (latest in the funnel)
    currentStage: {
        type: String,
        enum: [
            'lead_captured',
            'contacted',
            'qualified',
            'site_visit_scheduled',
            'site_visit_done',
            'offer_made',
            'negotiation',
            'deal_closed',
            'lost',
        ],
        default: 'lead_captured',
    },

    // Full timeline (all stages the lead has gone through)
    timeline: [journeyStageSchema],

    // Lead snapshot (cached from OneEmployee for quick display without cross-service call)
    leadSnapshot: {
        firstName: String,
        lastName: String,
        phone: String,
        email: String,
        source: String,                                  // facebook, google, manual, bulk_import
        score: Number,
        status: String,                                  // HOT, WARM, COLD, CREATED
        projectName: String,                             // Which project this lead is for
        campaignName: String,                            // Which campaign brought this lead
    },

    // Property interest details (filled during qualification)
    propertyInterest: {
        projectId: String,                               // HIT Project._id
        projectName: String,
        bhkPreference: String,                           // e.g. "2BHK", "3BHK"
        budgetRange: String,                             // e.g. "50L-80L"
        preferredLocation: String,
        timeline: String,                                // e.g. "Immediate", "3 months", "6 months"
        loanRequired: { type: Boolean, default: false },
    },

    // Conversion tracking
    isConverted: { type: Boolean, default: false },
    convertedAt: { type: Date },
    dealValue: { type: Number },                         // Final deal amount (₹)

    // Assignment
    assignedAgent: {
        userId: String,
        name: String,
    },

}, { timestamps: true });

// Compound unique: one journey per lead per owner
leadJourneySchema.index({ leadId: 1, ownerId: 1 }, { unique: true });
// Query: leads by current stage (for funnel dashboard)
leadJourneySchema.index({ ownerId: 1, currentStage: 1 });
// Query: converted leads (for deal reports)
leadJourneySchema.index({ ownerId: 1, isConverted: 1, convertedAt: -1 });

module.exports = mongoose.model('LeadJourney', leadJourneySchema);
