const User = require('../models/User');
const leadGenService = require('../services/LeadGenService');
const Logger = require('../utils/logger');

const logger = new Logger('CrmBridge');

/**
 * Silent auto-link helper.
 * Attempts to find and link a matching OneEmployee owner by phone/email.
 * Returns true if link succeeded, false otherwise.
 * NEVER throws — safe to call from any endpoint.
 */
async function silentAutoLink(user) {
    try {
        if (!user.phone && !user.email) return false;

        const lookupResult = await leadGenService.lookupOwner(user.phone, user.email);
        if (!lookupResult.found || !lookupResult.owner) return false;

        const owner = lookupResult.owner;
        const hitUserId = user._id.toString();
        const ownerId = owner._id.toString();

        // Don't steal link from another HIT user
        if (owner.salesProfileId && owner.salesProfileId !== hitUserId) return false;

        // Perform the link
        await leadGenService.linkOwner(ownerId, hitUserId);
        await User.findByIdAndUpdate(user._id, {
            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
        });

        logger.info('Silent auto-link succeeded', { userId: hitUserId, ownerId });
        return true;
    } catch (err) {
        logger.warn('Silent auto-link failed (non-blocking)', { error: err.message });
        return false;
    }
}

/**
 * POST /api/crm-bridge/link
 * Connects the authenticated HIT user to a matching LeadGen Owner.
 */
exports.link = async (req, res) => {
    try {
        const { phone, email } = req.user;

        // Require at least one identity field on the user
        if (!phone && !email) {
            return res.status(400).json({ error: 'User must have a phone or email to link' });
        }

        // Lookup matching owner in LeadGen by the HIT user's own phone/email
        const result = await leadGenService.lookupOwner(phone, email);

        if (!result.found) {
            return res.status(404).json({ error: 'NO_MATCHING_OWNER' });
        }

        const owner = result.owner;
        const hitUserId = req.user._id.toString();
        const newOwnerId = owner._id.toString();

        const alreadyLinkedToSame =
            req.user.oneEmployeeOwnerId &&
            req.user.oneEmployeeOwnerId === newOwnerId;

        // Detect a switch: user is already linked to a DIFFERENT owner
        const isSwitching =
            req.user.oneEmployeeOwnerId &&
            req.user.oneEmployeeOwnerId !== newOwnerId;

        const previousOwnerId = req.user.oneEmployeeOwnerId || null;

        if (isSwitching) {
            // Best-effort unlink the old owner before linking the new one
            try {
                await leadGenService.unlinkOwner(previousOwnerId);
            } catch (unlinkErr) {
                logger.error('Failed to unlink previous owner during switch (continuing)', {
                    previousOwnerId,
                    error: unlinkErr.message,
                });
            }
        }

        // Attempt to link the new owner
        let linkResult;
        try {
            linkResult = await leadGenService.linkOwner(newOwnerId, hitUserId);
        } catch (linkErr) {
            if (linkErr.status === 409) {
                // If we were switching, attempt to restore the old link (best-effort)
                if (isSwitching) {
                    try {
                        await leadGenService.linkOwner(previousOwnerId, hitUserId);
                    } catch (restoreErr) {
                        logger.error('Failed to restore previous owner link after 409 conflict', {
                            previousOwnerId,
                            error: restoreErr.message,
                        });
                    }
                }
                return res.status(409).json({ error: 'OWNER_ALREADY_LINKED' });
            }
            throw linkErr;
        }

        // If already linked to this same owner (idempotent case)
        if (linkResult && linkResult.alreadyLinked && alreadyLinkedToSame) {
            return res.json({ linked: true, alreadyLinked: true });
        }

        // Persist the link on the HIT User
        await User.findByIdAndUpdate(req.user._id, {
            $set: {
                oneEmployeeLinked: true,
                oneEmployeeOwnerId: newOwnerId,
            },
        });

        const response = {
            linked: true,
            ownerEmail: owner.email,
            ownerPhone: owner.phone || owner.mobile,
        };

        if (isSwitching) {
            response.switched = true;
        }

        return res.json(response);
    } catch (err) {
        logger.error('link error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/unlink
 * Disconnects the authenticated HIT user from their linked LeadGen Owner.
 */
exports.unlink = async (req, res) => {
    try {
        // Always re-fetch for freshness
        const user = await User.findById(req.user._id);

        if (!user.oneEmployeeLinked) {
            return res.status(400).json({ error: 'NOT_LINKED' });
        }

        const prevOwnerId = user.oneEmployeeOwnerId;

        // Clear HIT side first — even if LeadGen call fails, HIT side stays clean
        await User.findByIdAndUpdate(req.user._id, {
            $set: {
                oneEmployeeLinked: false,
                oneEmployeeOwnerId: null,
            },
        });

        try {
            await leadGenService.unlinkOwner(prevOwnerId);
        } catch (remoteErr) {
            logger.error('LeadGen unlink failed after HIT-side unlink', {
                prevOwnerId,
                error: remoteErr.message,
            });
            // HIT side is already clean — report partial success
            return res.json({ unlinked: true, partialUnlink: true });
        }

        return res.json({ unlinked: true });
    } catch (err) {
        logger.error('unlink error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/status
 * Returns the CRM link status for the authenticated user.
 * IMPROVEMENT: If not linked yet, silently attempts auto-link by phone/email.
 * This means the CRM "just works" without requiring a manual link step —
 * as long as a OneEmployee account exists with the same phone/email.
 */
exports.status = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'oneEmployeeLinked oneEmployeeOwnerId phone email'
        );

        // Already linked — return status from LeadGen
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId) {
            try {
                const ownerData = await leadGenService.getOwnerStatus(user.oneEmployeeOwnerId);
                return res.json({
                    linked: true,
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    connectedEmail: ownerData.owner.email,
                    connectedPhone: ownerData.owner.phone || ownerData.owner.mobile,
                });
            } catch (remoteErr) {
                logger.error('getOwnerStatus degraded — returning local data only', {
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    error: remoteErr.message,
                });
                return res.json({
                    linked: true,
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    degraded: true,
                });
            }
        }

        // ── Not linked yet — attempt silent auto-link ────────────────────────
        // If user has phone/email, check if a matching OneEmployee account exists.
        // If yes, link them silently (zero-friction CRM access).
        if (user.phone || user.email) {
            try {
                const lookupResult = await leadGenService.lookupOwner(user.phone, user.email);

                if (lookupResult.found && lookupResult.owner) {
                    const owner = lookupResult.owner;
                    const hitUserId = user._id.toString();
                    const ownerId = owner._id.toString();

                    // Only auto-link if owner is not already linked to someone else
                    if (!owner.salesProfileId || owner.salesProfileId === hitUserId) {
                        await leadGenService.linkOwner(ownerId, hitUserId);
                        await User.findByIdAndUpdate(user._id, {
                            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
                        });

                        logger.info('Silent auto-link succeeded on status check', { userId: hitUserId, ownerId });

                        return res.json({
                            linked: true,
                            autoLinked: true,
                            oneEmployeeOwnerId: ownerId,
                            connectedEmail: owner.email,
                            connectedPhone: owner.phone || owner.mobile,
                        });
                    }
                }
            } catch (autoLinkErr) {
                // Auto-link failed silently — don't block the status response
                logger.warn('Silent auto-link failed (non-blocking)', { error: autoLinkErr.message });
            }
        }

        // ── No matching OneEmployee account found — return options ────────
        // Production-level: give user clear next steps instead of just "not linked"
        const options = [];

        // Option 1: Create a new OneEmployee account (auto-provision)
        options.push({
            action: 'create_account',
            label: 'Create OneEmployee Account',
            description: 'Set up a new OneEmployee CRM account instantly using your current details. Get AI voice calling, WhatsApp automation, and lead management.',
            endpoint: '/api/crm-bridge/create-account',
            method: 'POST',
            auto: true,  // Can be triggered automatically by frontend
        });

        // Option 2: Link with different phone/email
        options.push({
            action: 'manual_link',
            label: 'Connect Existing Account',
            description: 'If you have a OneEmployee account with a different phone or email, enter those details to connect.',
            endpoint: '/api/crm-bridge/link',
            method: 'POST',
            requires: ['phoneOrEmail'],
        });

        // Option 3: SSO login to OneEmployee (if they want to register on oneemployee.in first)
        const redirectBase = process.env.LEADGEN_BACKEND_URL || 'https://lead-filteration-backend-624770114041.asia-south1.run.app';
        options.push({
            action: 'register_external',
            label: 'Register on OneEmployee',
            description: 'Sign up on oneemployee.in separately, then come back here to connect.',
            url: 'https://www.oneemployee.in/login',
            method: 'REDIRECT',
        });

        return res.json({
            linked: false,
            reason: 'NO_MATCHING_ACCOUNT',
            userPhone: user.phone || null,
            userEmail: user.email || null,
            options,
        });
    } catch (err) {
        logger.error('status error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/leads
 * Fetches paginated leads for the linked owner from LeadGen.
 * IMPROVEMENT: If not linked, attempts silent auto-link first.
 */
exports.getLeads = async (req, res) => {
    try {
        let user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId phone email');

        // Not linked — try silent auto-link before returning 403
        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            const linked = await silentAutoLink(user);
            if (linked) {
                user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
            }
        }

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { page, limit, status, search, startDate, endDate } = req.query;
        const params = { page, limit, status, search, startDate, endDate };

        const result = await leadGenService.getLeads(user.oneEmployeeOwnerId, params);
        return res.json(result);
    } catch (err) {
        logger.error('getLeads error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/leads/:leadId
 * Fetches a single lead by ID from LeadGen.
 * IMPROVEMENT: If not linked, attempts silent auto-link first.
 */
exports.getLeadById = async (req, res) => {
    try {
        let user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId phone email');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            const linked = await silentAutoLink(user);
            if (linked) {
                user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
            }
        }

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const result = await leadGenService.getLeadById(req.params.leadId, user.oneEmployeeOwnerId);
        return res.json(result);
    } catch (err) {
        logger.error('getLeadById error', { error: err.message, status: err.status, code: err.code, data: err.data });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/analytics
 * Fetches CRM analytics for the linked owner from LeadGen.
 * IMPROVEMENT: If not linked, attempts silent auto-link first.
 */
exports.getAnalytics = async (req, res) => {
    try {
        let user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId phone email');
        
        // Not linked — try silent auto-link before returning 403
        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            const linked = await silentAutoLink(user);
            if (linked) {
                user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
            }
        }
        
        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { startDate, endDate } = req.query;
        const params = { startDate, endDate };

        const result = await leadGenService.getAnalytics(user.oneEmployeeOwnerId, params);
        return res.json(result);
    } catch (err) {
        logger.error('getAnalytics error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/auto-link
 * Attempts to automatically find and link a matching LeadGen Owner
 * using the authenticated user's phone and email.
 * Safe to call repeatedly — idempotent.
 */
exports.autoLink = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'oneEmployeeLinked oneEmployeeOwnerId phone email role'
        );

        // Already linked — return current status
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId) {
            try {
                const ownerData = await leadGenService.getOwnerStatus(user.oneEmployeeOwnerId);
                return res.json({
                    linked: true,
                    alreadyLinked: true,
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    connectedEmail: ownerData.owner.email,
                    connectedPhone: ownerData.owner.phone || ownerData.owner.mobile,
                });
            } catch {
                return res.json({
                    linked: true,
                    alreadyLinked: true,
                    oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                    degraded: true,
                });
            }
        }

        if (!user.phone && !user.email) {
            return res.status(400).json({ error: 'User has no phone or email to match against' });
        }

        const result = await leadGenService.lookupOwner(user.phone, user.email);

        if (!result.found || !result.owner) {
            return res.status(404).json({ error: 'NO_MATCHING_OWNER', linked: false });
        }

        const owner = result.owner;
        const hitUserId = user._id.toString();
        const ownerId = owner._id.toString();

        // Owner already linked to a different HIT user
        if (owner.salesProfileId && owner.salesProfileId !== hitUserId) {
            return res.status(409).json({ error: 'OWNER_ALREADY_LINKED', linked: false });
        }

        // Perform the link (idempotent if already same)
        await leadGenService.linkOwner(ownerId, hitUserId);
        await User.findByIdAndUpdate(user._id, {
            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId }
        });

        logger.info('Auto-link via API succeeded', { userId: hitUserId, ownerId });

        return res.json({
            linked: true,
            autoLinked: true,
            ownerEmail: owner.email,
            ownerPhone: owner.phone || owner.mobile,
        });
    } catch (err) {
        logger.error('autoLink error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/redirect-base
 * Returns the LeadGen backend URL for SSO redirects.
 * Frontend uses this to construct the SSO validate URL.
 */
exports.getRedirectBase = async (req, res) => {
    return res.json({
        redirectBase: process.env.LEADGEN_BACKEND_URL ||
            'https://lead-filteration-backend-624770114041.asia-south1.run.app'
    });
};

/**
 * POST /api/crm-bridge/sso-token
 * Issues a short-lived SSO token for the linked LeadGen owner.
 */
exports.issueSsoToken = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        // Validate redirectPath — must start with '/', max 500 chars. Default to '/' if invalid.
        let { redirectPath } = req.body;
        if (
            !redirectPath ||
            typeof redirectPath !== 'string' ||
            !redirectPath.startsWith('/') ||
            redirectPath.length > 500
        ) {
            redirectPath = '/';
        }

        const result = await leadGenService.issueSsoToken(
            req.user._id.toString(),
            user.oneEmployeeOwnerId,
            redirectPath
        );

        return res.json({ token: result.token, expiresIn: result.expiresIn });
    } catch (err) {
        logger.error('issueSsoToken error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/create-account
 * Auto-provisions a new OneEmployee account for the authenticated HIT user.
 * Uses the user's existing phone/email/name to create the account,
 * then auto-links it to this HIT user.
 *
 * Flow:
 *   1. Check user not already linked
 *   2. Call LeadGen Backend /api/auth/register (or internal create endpoint)
 *   3. Link the newly created owner to this HIT user
 *   4. Return success with connection details
 *
 * Production safeguards:
 *   - Idempotent: if account already exists (409 from LeadGen), auto-links instead
 *   - Validates phone exists on user (required for OneEmployee)
 *   - Rate limited via crmAuth middleware
 */
exports.createAccount = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'oneEmployeeLinked oneEmployeeOwnerId phone email name companyName role'
        );

        // Already linked — return existing connection
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId) {
            return res.json({
                created: false,
                alreadyLinked: true,
                oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                message: 'Already connected to OneEmployee',
            });
        }

        // Must have a phone number (OneEmployee requires it)
        if (!user.phone) {
            return res.status(400).json({
                error: 'Phone number required',
                message: 'Please add your phone number in your profile first. OneEmployee requires a phone number for the account.',
            });
        }

        const axios = require('axios');
        const LEADGEN_URL = process.env.LEADGEN_BACKEND_URL || 'https://lead-filteration-backend-624770114041.asia-south1.run.app';
        const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'hit-internal-secret-2024';

        // Attempt 1: Try to lookup existing account first (maybe phone is registered but not linked)
        try {
            const lookupResult = await leadGenService.lookupOwner(user.phone, user.email);
            if (lookupResult.found && lookupResult.owner) {
                const owner = lookupResult.owner;
                const hitUserId = user._id.toString();
                const ownerId = owner._id.toString();

                // Check if owner is free to link
                if (!owner.salesProfileId || owner.salesProfileId === hitUserId) {
                    await leadGenService.linkOwner(ownerId, hitUserId);
                    await User.findByIdAndUpdate(user._id, {
                        $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
                    });

                    logger.info('create-account: existing account found and linked', { userId: hitUserId, ownerId });
                    return res.json({
                        created: false,
                        linked: true,
                        existingAccount: true,
                        oneEmployeeOwnerId: ownerId,
                        connectedEmail: owner.email,
                        connectedPhone: owner.phone || owner.mobile,
                        message: 'Found your existing OneEmployee account and connected it.',
                    });
                } else {
                    return res.status(409).json({
                        error: 'ACCOUNT_LINKED_TO_OTHER',
                        message: 'A OneEmployee account with your phone/email exists but is already linked to another user.',
                    });
                }
            }
        } catch (lookupErr) {
            // 404 or network error — proceed to create
            if (lookupErr.status && lookupErr.status !== 404) {
                logger.warn('create-account: lookup failed, proceeding to create', { error: lookupErr.message });
            }
        }

        // Attempt 2: Create a new OneEmployee account via internal API
        try {
            const createRes = await axios.post(`${LEADGEN_URL}/api/internal/identity/create-owner`, {
                phone: user.phone,
                email: user.email || undefined,
                name: user.name || 'User',
                companyName: user.companyName || undefined,
                role: 'service_user',
                hitUserId: user._id.toString(),
                source: 'hit_crm_bridge',
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-secret': INTERNAL_SECRET,
                },
                timeout: 15000,
            });

            if (createRes.data.success || createRes.data.owner) {
                const owner = createRes.data.owner;
                const ownerId = owner._id || owner.id;

                // Link the new account
                await User.findByIdAndUpdate(user._id, {
                    $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
                });

                logger.info('create-account: new OneEmployee account created and linked', {
                    userId: user._id.toString(),
                    ownerId,
                });

                return res.status(201).json({
                    created: true,
                    linked: true,
                    oneEmployeeOwnerId: ownerId,
                    connectedPhone: user.phone,
                    connectedEmail: user.email || null,
                    message: 'OneEmployee account created and connected. You can now access CRM features.',
                    features: [
                        'AI Voice Calling',
                        'WhatsApp Automation',
                        'Email Campaigns',
                        'Lead Management & Scoring',
                        'Facebook & Google Ads Integration',
                        'Social Media Posting & Auto-Reply',
                    ],
                });
            }

            throw new Error(createRes.data.error || 'Account creation failed');
        } catch (createErr) {
            // 409 = account already exists with this phone (race condition with lookup)
            if (createErr.response?.status === 409) {
                // Try one more lookup + link
                try {
                    const retryLookup = await leadGenService.lookupOwner(user.phone, user.email);
                    if (retryLookup.found && retryLookup.owner) {
                        const ownerId = retryLookup.owner._id.toString();
                        await leadGenService.linkOwner(ownerId, user._id.toString());
                        await User.findByIdAndUpdate(user._id, {
                            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
                        });
                        return res.json({
                            created: false,
                            linked: true,
                            existingAccount: true,
                            oneEmployeeOwnerId: ownerId,
                            message: 'Account already existed — connected successfully.',
                        });
                    }
                } catch { /* fall through to error */ }
            }

            logger.error('create-account: failed', { error: createErr.response?.data || createErr.message });
            return res.status(createErr.response?.status || 500).json({
                error: 'ACCOUNT_CREATION_FAILED',
                message: createErr.response?.data?.error || createErr.message || 'Failed to create OneEmployee account. Please try again.',
            });
        }
    } catch (err) {
        logger.error('createAccount error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/link-by-identifier
 * Links using a specific phone or email (manual entry by user).
 * Used when user's HIT phone/email doesn't match their OneEmployee account.
 */
exports.linkByIdentifier = async (req, res) => {
    try {
        const { phoneOrEmail } = req.body;
        if (!phoneOrEmail || !phoneOrEmail.trim()) {
            return res.status(400).json({ error: 'Phone number or email is required' });
        }

        const identifier = phoneOrEmail.trim();
        const isEmail = identifier.includes('@');
        const phone = isEmail ? null : identifier.replace(/\D/g, '');
        const email = isEmail ? identifier : null;

        // Lookup in OneEmployee
        const lookupResult = await leadGenService.lookupOwner(phone, email);
        if (!lookupResult.found || !lookupResult.owner) {
            return res.status(404).json({
                error: 'NO_ACCOUNT_FOUND',
                message: `No OneEmployee account found with ${isEmail ? 'email' : 'phone'}: ${identifier}`,
            });
        }

        const owner = lookupResult.owner;
        const hitUserId = req.user._id.toString();
        const ownerId = owner._id.toString();

        // Check if already linked to another user
        if (owner.salesProfileId && owner.salesProfileId !== hitUserId) {
            return res.status(409).json({
                error: 'OWNER_ALREADY_LINKED',
                message: 'This OneEmployee account is already connected to another HomeInTown account.',
            });
        }

        // Check if current user already linked to a DIFFERENT owner
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId && user.oneEmployeeOwnerId !== ownerId) {
            // Unlink old first
            try {
                await leadGenService.unlinkOwner(user.oneEmployeeOwnerId);
            } catch { /* best-effort */ }
        }

        // Perform the link
        await leadGenService.linkOwner(ownerId, hitUserId);
        await User.findByIdAndUpdate(req.user._id, {
            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId },
        });

        logger.info('linkByIdentifier succeeded', { userId: hitUserId, ownerId, identifier });

        return res.json({
            linked: true,
            oneEmployeeOwnerId: ownerId,
            connectedEmail: owner.email,
            connectedPhone: owner.phone || owner.mobile,
            message: 'Successfully connected to OneEmployee.',
        });
    } catch (err) {
        logger.error('linkByIdentifier error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};
