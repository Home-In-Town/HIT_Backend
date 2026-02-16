const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');
const WebhookQueue = require('../models/WebhookQueue');

// We need the signature generator from WebhookService, but to avoid circular dependencies
// we can implement it here or move it to a utility.
const generateSignature = (payload, secret) => {
    return crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');
};

const WEBHOOK_CONFIG = {
    url: process.env.LEAD_FILTERATION_WEBHOOK_URL || 'http://localhost:5002/api/webhook/analytics',
    secret: process.env.HIT_WEBHOOK_SECRET,
    timeout: 5000
};

/**
 * Process pending webhooks from the queue
 */
const processWebhookQueue = async () => {
    const pendingWebhooks = await WebhookQueue.find({
        status: 'pending',
        nextRetry: { $lte: new Date() },
        attempts: { $lt: 5 }
    }).limit(10); // Process 10 at a time

    if (pendingWebhooks.length === 0) return;

    console.log(`🔄 Processing ${pendingWebhooks.length} pending webhooks...`);

    for (const webhook of pendingWebhooks) {
        webhook.attempts += 1;
        
        const signature = generateSignature(webhook.payload, WEBHOOK_CONFIG.secret);

        try {
            await axios.post(WEBHOOK_CONFIG.url, webhook.payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                    'X-Webhook-Source': 'sales-website'
                },
                timeout: WEBHOOK_CONFIG.timeout
            });

            webhook.status = 'sent';
            console.log(`✅ [CRON] Webhook ${webhook.eventId} sent successfully.`);
        } catch (error) {
            console.error(`❌ [CRON] Webhook ${webhook.eventId} attempt ${webhook.attempts} failed:`, error.message);
            
            if (webhook.attempts >= webhook.maxAttempts) {
                webhook.status = 'failed';
            } else {
                // Exponential backoff: 5m, 15m, 45m, 2h
                const backoffMinutes = Math.pow(3, webhook.attempts) * 5;
                webhook.nextRetry = new Date(Date.now() + backoffMinutes * 60 * 1000);
            }
            webhook.lastError = error.message;
        }

        await webhook.save();
    }
};

/**
 * Initialize the cron job
 */
const initWebhookCron = () => {
    // Run every 5 minutes
    cron.schedule('*/5 * * * *', () => {
        processWebhookQueue().catch(err => console.error('Error in WebhookCron:', err));
    });
    console.log('⏰ Webhook Retry Cron initialized (runs every 5m)');
};

module.exports = { initWebhookCron, processWebhookQueue };
