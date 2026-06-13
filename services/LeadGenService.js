/**
 * LeadGenService
 * All server-to-server calls from HIT_Backend to LeadGen_Backend.
 * - 8s timeout on every request
 * - 1 retry on 5xx or network error (after 1000ms delay)
 * - X-Request-ID header (uuid v4) on every request
 * - x-internal-secret masked in logs
 */
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const BASE_URL = () => {
    const url = process.env.LEADGEN_BACKEND_URL;
    if (!url) throw new Error('LEADGEN_BACKEND_URL environment variable is not set');
    return url.replace(/\/+$/, ''); // strip trailing slash
};

const getHeaders = (requestId) => ({
    'Content-Type': 'application/json',
    'x-internal-secret': process.env.INTERNAL_API_SECRET || 'hit-internal-secret-2024',
    'X-Request-ID': requestId || uuidv4(),
});

const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 1000;

/**
 * Makes an HTTP request with 1 retry on 5xx or network error.
 * Does NOT retry on 4xx errors.
 */
async function requestWithRetry(config, requestId) {
    const headers = getHeaders(requestId || uuidv4());
    const fullConfig = { ...config, timeout: TIMEOUT_MS, headers: { ...headers, ...(config.headers || {}) } };

    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axios(fullConfig);
            return response.data;
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            // 4xx: don't retry, throw immediately
            if (status && status >= 400 && status < 500) {
                const error = new Error(err.response?.data?.error || `Request failed with status ${status}`);
                error.status = status;
                error.code = err.response?.data?.error || String(status);
                error.data = err.response?.data;
                throw error;
            }
            // 5xx or network: retry once after delay
            if (attempt === 1) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }
    }

    // Both attempts failed (5xx or network)
    const status = lastError?.response?.status || 503;
    const error = new Error(lastError?.response?.data?.error || lastError?.message || 'LeadGen service unavailable');
    error.status = status;
    error.code = lastError?.response?.data?.error || 'LEADGEN_UNAVAILABLE';
    throw error;
}

class LeadGenService {

    // ── Identity ─────────────────────────────────────────────────────────────

    async lookupOwner(phone, email) {
        return requestWithRetry({
            method: 'POST',
            url: `${BASE_URL()}/api/internal/identity/lookup`,
            data: { phone, email },
        });
    }

    async linkOwner(ownerId, hitUserId) {
        return requestWithRetry({
            method: 'POST',
            url: `${BASE_URL()}/api/internal/identity/link`,
            data: { ownerId, hitUserId },
        });
    }

    async unlinkOwner(ownerId) {
        return requestWithRetry({
            method: 'POST',
            url: `${BASE_URL()}/api/internal/identity/unlink`,
            data: { ownerId },
        });
    }

    async getOwnerStatus(ownerId) {
        return requestWithRetry({
            method: 'GET',
            url: `${BASE_URL()}/api/internal/identity/owner/${encodeURIComponent(ownerId)}`,
        });
    }

    // ── CRM Data ─────────────────────────────────────────────────────────────

    async getLeads(salesProfileId, params = {}) {
        const queryParams = new URLSearchParams({ salesProfileId });
        if (params.page)      queryParams.set('page', params.page);
        if (params.limit)     queryParams.set('limit', params.limit);
        if (params.status)    queryParams.set('status', params.status);
        if (params.search)    queryParams.set('search', params.search);
        if (params.startDate) queryParams.set('startDate', params.startDate);
        if (params.endDate)   queryParams.set('endDate', params.endDate);

        return requestWithRetry({
            method: 'GET',
            url: `${BASE_URL()}/api/internal/crm/leads?${queryParams.toString()}`,
        });
    }

    async getLeadById(leadId, salesProfileId) {
        return requestWithRetry({
            method: 'GET',
            url: `${BASE_URL()}/api/internal/crm/leads/${encodeURIComponent(leadId)}?salesProfileId=${encodeURIComponent(salesProfileId)}`,
        });
    }

    async getAnalytics(salesProfileId, params = {}) {
        const queryParams = new URLSearchParams({ salesProfileId });
        if (params.startDate) queryParams.set('startDate', params.startDate);
        if (params.endDate)   queryParams.set('endDate', params.endDate);

        return requestWithRetry({
            method: 'GET',
            url: `${BASE_URL()}/api/internal/crm/analytics?${queryParams.toString()}`,
        });
    }

    // ── SSO ──────────────────────────────────────────────────────────────────

    async issueSsoToken(hitUserId, salesProfileId, redirectPath) {
        return requestWithRetry({
            method: 'POST',
            url: `${BASE_URL()}/api/internal/sso/issue-token`,
            data: { hitUserId, salesProfileId, redirectPath },
        });
    }
}

module.exports = new LeadGenService();
