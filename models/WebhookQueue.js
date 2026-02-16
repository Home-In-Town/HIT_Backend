const mongoose = require('mongoose');

const WebhookQueueSchema = new mongoose.Schema({
    eventType: {
        type: String,
        required: true
    },
    payload: {
        type: Object,
        required: true
    },
    attempts: {
        type: Number,
        default: 0
    },
    maxAttempts: {
        type: Number,
        default: 5
    },
    status: {
        type: String,
        enum: ['pending', 'failed', 'sent'],
        default: 'pending'
    },
    lastError: {
        type: String
    },
    nextRetry: {
        type: Date,
        default: Date.now
    },
    eventId: {
        type: String,
        required: true,
        unique: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('WebhookQueue', WebhookQueueSchema);
