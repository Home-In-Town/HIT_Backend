const User = require('../models/User');
const leadGenService = require('../services/LeadGenService');
const Logger = require('../utils/logger');

const logger = new Logger('CrmBridge');

/**
 * Attempt to auto-connect CRM for a HIT user.
 * Uses the user's phone/email to find matching OneEmployee account.
 * If found and available → links both sides automatically.
 * Returns: { connected: true, ownerId } or { connected: false, reason }
 * NEVER throws.
 */
async function attemptAutoConnect(user) {
    try {
        if (!user.phone && !user.email) {
            return { connected: false, reason: 'no_identity' };
        }

        // Lookup OneEmployee owner by this HIT user's phone/email
        const lookupResult = await leadGenService.lookupOwner(user.phone, user.email);
        if (!lookupResult.found || !lookupResult.owner) {
            return { connected: false, reason: 'no_account' };
        }

        const owner = lookupResult.owner;
        const hitUserId = user._id.toString();
        const ownerId = owner._id.toString();

        // Check if this owner is "available" for this HIT user:
        // - Not linked to anyone → free to link
        // - Linked to THIS same HIT user (via salesProfileId OR hitUserId) → already ours
        // - Linked to a DIFFERENT HIT user → conflict (truly different person)
        const linkedToMe = 
            owner.salesProfileId === hitUserId ||
            owner.hitUserId === hitUserId;
        const linkedToOther = 
            (owner.salesProfileId && owner.salesProfileId !== hitUserId) &&
            (owner.hitUserId && owner.hitUserId !== hitUserId);
        const isFree = !owner.salesProfileId && !owner.hitUserId;

        if (linkedToOther) {
            return { connected: false, reason: 'linked_to_other', ownerPhone: owner.phone };
        }

        // Either free or already ours — perform/confirm the link
        try {
            await leadGenService.linkOwner(ownerId, hitUserId);
        } catch (linkErr) {
            // Even if LeadGen returns 409, if owner is linked to us, just proceed
            if (linkErr.status === 409 && linkedToMe) {
                // Link exists on LeadGen side, just fix HIT side
            } else if (linkErr.status === 409) {
                return { connected: false, reason: 'linked_to_other' };
            } else {
                throw linkErr;
            }
        }

        // Update HIT side
        await User.findByIdAndUpdate(user._id, {
            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
        });

        logger.info('Auto-connect succeeded', { userId: hitUserId, ownerId });
        return { connected: true, ownerId, ownerEmail: owner.email, ownerPhone: owner.phone };
    } catch (err) {
        logger.warn('Auto-connect failed', { error: err.message });
        return { connected: false, reason: 'error', message: err.message };
    }
}

/**
 * GET /api/crm-bridge/status
 * Returns CRM connection status.
 * If not connected → attempts auto-connect using HIT user's phone/email.
 * If auto-connect fails → returns options for manual connect.
 */
exports.status = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'oneEmployeeLinked oneEmployeeOwnerId phone email name'
        );

        // Already connected — verify and return
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId) {
            try {
                const ownerData = await leadGenService.getOwnerStatus(user.oneEmployeeOwnerId);
                return res.json({
                    linked: true,
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    connectedEmail: ownerData.owner.email,
                    connectedPhone: ownerData.owner.phone || ownerData.owner.mobile,
                });
            } catch {
                return res.json({
                    linked: true,
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    degraded: true,
                });
            }
        }

        // Not connected — try auto-connect
        const result = await attemptAutoConnect(user);

        if (result.connected) {
            return res.json({
                linked: true,
                autoLinked: true,
                oneEmployeeOwnerId: result.ownerId,
                connectedEmail: result.ownerEmail,
                connectedPhone: result.ownerPhone,
            });
        }

        // Auto-connect failed — return reason + manual options
        return res.json({
            linked: false,
            reason: result.reason,
            userPhone: user.phone || null,
            userEmail: user.email || null,
            options: [
                {
                    action: 'manual_connect',
                    label: 'Connect with PIN',
                    description: 'Enter your OneEmployee PIN to verify and connect your account.',
                    endpoint: '/api/crm-bridge/manual-connect',
                    method: 'POST',
                    requires: ['pin'],
                },
                {
                    action: 'register_external',
                    label: 'Create OneEmployee Account',
                    description: 'Sign up on oneemployee.in first, then connection will happen automatically.',
                    url: 'https://www.oneemployee.in/login',
                    method: 'REDIRECT',
                },
            ],
        });
    } catch (err) {
        logger.error('status error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/auto-link
 * Explicit auto-link trigger (called by frontend on CRM page load).
 * Same logic as status auto-connect.
 */
exports.autoLink = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'oneEmployeeLinked oneEmployeeOwnerId phone email'
        );

        // Already linked
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId) {
            return res.json({ linked: true, alreadyLinked: true, oneEmployeeOwnerId: user.oneEmployeeOwnerId });
        }

        const result = await attemptAutoConnect(user);

        if (result.connected) {
            return res.json({
                linked: true,
                autoLinked: true,
                oneEmployeeOwnerId: result.ownerId,
                connectedEmail: result.ownerEmail,
                connectedPhone: result.ownerPhone,
            });
        }

        return res.status(404).json({
            linked: false,
            error: 'NO_MATCHING_OWNER',
            reason: result.reason,
        });
    } catch (err) {
        logger.error('autoLink error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/manual-connect
 * Manual connection with PIN verification.
 * Body: { phone, pin } — user enters their OneEmployee phone + PIN.
 * Verifies credentials against OneEmployee auth, then links.
 */
exports.manualConnect = async (req, res) => {
    try {
        const { phone, pin } = req.body;

        if (!phone || !pin) {
            return res.status(400).json({ error: 'Phone and PIN are required' });
        }

        const hitUserId = req.user._id.toString();

        // Verify PIN against OneEmployee login endpoint
        const axios = require('axios');
        const LEADGEN_URL = process.env.LEADGEN_BACKEND_URL || 'https://lead-filteration-backend-624770114041.asia-south1.run.app';

        let loginResult;
        try {
            const loginRes = await axios.post(`${LEADGEN_URL}/api/auth/login`, {
                phone: phone.replace(/\D/g, ''),
                mpin: pin.toString(),
            }, { timeout: 10000, validateStatus: (s) => s < 500 });

            if (loginRes.status === 200 && loginRes.data.user) {
                loginResult = loginRes.data.user;
            } else {
                return res.status(401).json({ error: 'Invalid phone or PIN. Please check and try again.' });
            }
        } catch (authErr) {
            if (authErr.response?.status === 401 || authErr.response?.status === 403) {
                return res.status(401).json({ error: 'Invalid phone or PIN. Please check and try again.' });
            }
            return res.status(502).json({ error: 'Could not reach OneEmployee. Please try again.' });
        }

        // Found the owner — now link
        const ownerId = loginResult.id || loginResult._id;

        try {
            await leadGenService.linkOwner(ownerId, hitUserId);
        } catch (linkErr) {
            if (linkErr.status === 409) {
                // Force link — user proved ownership via PIN
                // Update Owner's salesProfileId + hitUserId directly
                const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'hit-internal-secret-2024';
                try {
                    await axios.post(`${LEADGEN_URL}/api/internal/identity/link`, {
                        ownerId,
                        hitUserId,
                        force: true,
                    }, {
                        headers: { 'x-internal-secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
                        timeout: 10000,
                    });
                } catch {
                    return res.status(409).json({ error: 'Account is linked to another user and could not be transferred.' });
                }
            } else {
                throw linkErr;
            }
        }

        // Update HIT side
        await User.findByIdAndUpdate(req.user._id, {
            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
        });

        logger.info('Manual connect with PIN succeeded', { userId: hitUserId, ownerId });

        return res.json({
            linked: true,
            manualLinked: true,
            oneEmployeeOwnerId: ownerId,
            message: 'Successfully connected to OneEmployee.',
        });
    } catch (err) {
        logger.error('manualConnect error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/link
 * Legacy link endpoint — kept for backward compatibility.
 */
exports.link = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('phone email oneEmployeeOwnerId');
        const result = await attemptAutoConnect(user);

        if (result.connected) {
            return res.json({ linked: true, ownerEmail: result.ownerEmail, ownerPhone: result.ownerPhone });
        }

        return res.status(result.reason === 'linked_to_other' ? 409 : 404).json({
            error: result.reason === 'linked_to_other' ? 'OWNER_ALREADY_LINKED' : 'NO_MATCHING_OWNER',
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/unlink
 */
exports.unlink = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user.oneEmployeeLinked) {
            return res.status(400).json({ error: 'NOT_LINKED' });
        }

        const prevOwnerId = user.oneEmployeeOwnerId;

        await User.findByIdAndUpdate(req.user._id, {
            $set: { oneEmployeeLinked: false, oneEmployeeOwnerId: null },
        });

        try {
            await leadGenService.unlinkOwner(prevOwnerId);
        } catch (remoteErr) {
            logger.error('LeadGen unlink failed (HIT side already clean)', { error: remoteErr.message });
            return res.json({ unlinked: true, partialUnlink: true });
        }

        return res.json({ unlinked: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/leads
 */
exports.getLeads = async (req, res) => {
    try {
        let user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId phone email');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            const result = await attemptAutoConnect(user);
            if (result.connected) {
                user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
            }
        }

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { page, limit, status, search, startDate, endDate } = req.query;
        const result = await leadGenService.getLeads(user.oneEmployeeOwnerId, { page, limit, status, search, startDate, endDate });
        return res.json(result);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/leads/:leadId
 */
exports.getLeadById = async (req, res) => {
    try {
        let user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId phone email');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            const result = await attemptAutoConnect(user);
            if (result.connected) {
                user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
            }
        }

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const result = await leadGenService.getLeadById(req.params.leadId, user.oneEmployeeOwnerId);
        return res.json(result);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/analytics
 */
exports.getAnalytics = async (req, res) => {
    try {
        let user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId phone email');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            const result = await attemptAutoConnect(user);
            if (result.connected) {
                user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
            }
        }

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { startDate, endDate } = req.query;
        const result = await leadGenService.getAnalytics(user.oneEmployeeOwnerId, { startDate, endDate });
        return res.json(result);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/redirect-base
 */
exports.getRedirectBase = async (req, res) => {
    return res.json({
        redirectBase: process.env.LEADGEN_BACKEND_URL ||
            'https://lead-filteration-backend-624770114041.asia-south1.run.app'
    });
};

/**
 * POST /api/crm-bridge/sso-token
 */
exports.issueSsoToken = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        let { redirectPath } = req.body;
        if (!redirectPath || typeof redirectPath !== 'string' || !redirectPath.startsWith('/') || redirectPath.length > 500) {
            redirectPath = '/';
        }

        const result = await leadGenService.issueSsoToken(
            req.user._id.toString(),
            user.oneEmployeeOwnerId,
            redirectPath
        );

        return res.json({ token: result.token, expiresIn: result.expiresIn });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
};

// Keep backward compat exports
exports.linkByIdentifier = exports.manualConnect;
exports.createAccount = async (req, res) => {
    return res.status(410).json({ error: 'Use manual-connect with PIN instead. Or register on oneemployee.in first.' });
};
