/**
 * WebhookService
 * Dispatches tracking events to external systems (e.g., lead-filteration)
 */
const axios = require('axios');
const crypto = require('crypto');

// Webhook configuration - can be moved to env or database later
const WEBHOOK_CONFIG = {
    url: process.env.LEAD_FILTERATION_WEBHOOK_URL || 'http://localhost:5002/api/webhook/analytics',
    enabled: process.env.WEBHOOK_ENABLED !== 'false',
    secret: process.env.WEBHOOK_SECRET || 'hit-webhook-secret-2024',
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
        return { success: true, skipped: true };
    }

    const webhookPayload = {
        eventType,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        source: 'sales-website',
        data: payload
    };

    const signature = generateSignature(webhookPayload, WEBHOOK_CONFIG.secret);

    let lastError = null;
    for (let attempt = 1; attempt <= WEBHOOK_CONFIG.retries; attempt++) {
        try {
            const response = await axios.post(WEBHOOK_CONFIG.url, webhookPayload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                    'X-Webhook-Source': 'sales-website'
                },
                timeout: WEBHOOK_CONFIG.timeout
            });

            return {
                success: true,
                status: response.status,
                data: response.data
            };
        } catch (error) {
            lastError = error;
            console.error(`❌ Webhook attempt ${attempt} failed:`, error.message);

            // Don't retry on 4xx errors (client errors)
            if (error.response && error.response.status >= 400 && error.response.status < 500) {
                break;
            }
        }
    }

    console.error(`❌ Webhook failed after ${WEBHOOK_CONFIG.retries} attempts:`, lastError?.message);
    return {
        success: false,
        error: lastError?.message || 'Unknown error'
    };
};

/**
 * Send page view event
 */
const sendPageViewEvent = async (data) => {
    return sendWebhook('page_view', {
        leadId: data.leadId,
        automationId: data.automationId,
        projectId: data.projectId,
        projectSlug: data.projectSlug,
        visitId: data.visitId,
        userAgent: data.userAgent,
        referrer: data.referrer,
        // New enriched fields
        device: data.device || null,
        sections: data.sections || [],
        ownerId: data.ownerId || null,
        sessionId: data.sessionId || null,
    });
};

/**
 * Send CTA click event
 */
const sendCtaClickEvent = async (data) => {
    return sendWebhook('cta_click', {
        leadId: data.leadId,
        automationId: data.automationId,
        projectId: data.projectId,
        ctaType: data.ctaType, // 'call', 'whatsapp', 'form'
        clickId: data.clickId,
        // New enriched fields
        ownerId: data.ownerId || null,
    });
};

/**
 * Send time update event
 */
const sendTimeUpdateEvent = async (data) => {
    return sendWebhook('time_update', {
        leadId: data.leadId,
        automationId: data.automationId,
        projectId: data.projectId,
        visitId: data.visitId,
        duration: data.duration,
        // New enriched fields
        sessionId: data.sessionId || null,
        ownerId: data.ownerId || null,
    });
};

/**
 * Send form submit event
 */
const sendFormSubmitEvent = async (data) => {
    return sendWebhook('form_submit', {
        leadId: data.leadId,
        automationId: data.automationId,
        projectId: data.projectId,
        formData: data.formData,
        // New enriched fields
        ownerId: data.ownerId || null,
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
