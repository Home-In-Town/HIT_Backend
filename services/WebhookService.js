/**
 * WebhookService
 * Dispatches tracking events to external systems (e.g., lead-filteration)
 */
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const WebhookQueue = require('../models/WebhookQueue');
const logger = require('../utils/logger');

// Webhook configuration - can be moved to env or database later
const WEBHOOK_CONFIG = {
    url: process.env.LEAD_FILTERATION_WEBHOOK_URL || 'http://localhost:5002/api/webhook/analytics',
    enabled: process.env.WEBHOOK_ENABLED !== 'false',
    secret: process.env.HIT_WEBHOOK_SECRET,
    timeout: 5000,
    retries: 2
};

/**
 * Generate HMAC signature for payload verification
 */
const generateSignature = (payload, secret) => {
    const crypto = require('crypto');
    return crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');
};

/**
 * Send webhook event to external system
 * @param {string} eventType - Type of event (page_view, cta_click, time_update, form_submit)
 * @param {Object} payload - Event data
 * @returns {Promise<Object>} Result
 */
const sendWebhook = async (eventType, payload) => {
    if (!WEBHOOK_CONFIG.enabled) {
        logger.info('webhook', { status: 'skipped', reason: 'disabled', eventType });
        return { success: true, skipped: true };
    }

    const eventId = uuidv4();
    const webhookPayload = {
        eventType,
        timestamp: new Date().toISOString(),
        source: 'sales-website',
        eventId,
        data: payload
    };

    const signature = generateSignature(webhookPayload, WEBHOOK_CONFIG.secret);

    let lastError = null;
    let success = false;

    for (let attempt = 1; attempt <= WEBHOOK_CONFIG.retries; attempt++) {
        try {
            logger.info('webhook', { status: 'sending', attempt, eventType, eventId });
            
            const response = await axios.post(WEBHOOK_CONFIG.url, webhookPayload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                    'X-Webhook-Source': 'sales-website'
                },
                timeout: WEBHOOK_CONFIG.timeout
            });

            logger.info('webhook', { status: 'sent', eventType, eventId });
            success = true;
            return {
                success: true,
                status: response.status,
                data: response.data
            };
        } catch (error) {
            lastError = error;
            logger.error('webhook', { status: 'failed_attempt', attempt, eventType, eventId, error: error.message });

            // Don't retry on 4xx errors (client errors)
            if (error.response && error.response.status >= 400 && error.response.status < 500) {
                break;
            }
        }
    }

    if (!success) {
        logger.error('webhook', { status: 'exhausted', eventType, eventId, error: lastError?.message });
        try {
            await WebhookQueue.create({
                eventType,
                payload: webhookPayload,
                eventId,
                status: 'pending',
                attempts: WEBHOOK_CONFIG.retries,
                lastError: lastError?.message || 'Unknown error',
                nextRetry: new Date(Date.now() + 5 * 60 * 1000) // Retry in 5 minutes
            });
            logger.info('webhook', { status: 'queued', eventType, eventId });
        } catch (dbError) {
            logger.error('webhook', { status: 'queue_failed', eventType, eventId, error: dbError.message });
        }
    }

    return {
        success: false,
        error: lastError?.message || 'Unknown error',
        queued: !success
    };
};


/**
 * Send page view event
 */
const sendPageViewEvent = async (data) => {
    return sendWebhook('page_view', {
        leadId: data.leadId,
        projectId: data.projectId,
        projectSlug: data.projectSlug,
        visitId: data.visitId,
        userAgent: data.userAgent,
        referrer: data.referrer
    });
};

/**
 * Send CTA click event
 */
const sendCtaClickEvent = async (data) => {
    return sendWebhook('cta_click', {
        leadId: data.leadId,
        projectId: data.projectId,
        ctaType: data.ctaType, // 'call', 'whatsapp', 'form'
        clickId: data.clickId
    });
};

/**
 * Send time update event
 */
const sendTimeUpdateEvent = async (data) => {
    return sendWebhook('time_update', {
        leadId: data.leadId,
        projectId: data.projectId,
        visitId: data.visitId,
        duration: data.duration
    });
};

/**
 * Send form submit event
 */
const sendFormSubmitEvent = async (data) => {
    return sendWebhook('form_submit', {
        leadId: data.leadId,
        projectId: data.projectId,
        formData: data.formData
    });
};

module.exports = {
    sendWebhook,
    sendPageViewEvent,
    sendCtaClickEvent,
    sendTimeUpdateEvent,
    sendFormSubmitEvent,
    WEBHOOK_CONFIG
};
