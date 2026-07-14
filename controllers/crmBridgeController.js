const User = require('../models/User');
const leadGenService = require('../services/LeadGenService');
const Logger = require('../utils/logger');

const logger = new Logger('CrmBridge');

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
 */
exports.status = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked) {
            return res.json({ linked: false });
        }

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
            // Degrade gracefully: return local data with a flag
            return res.json({
                linked: true,
                oneEmployeeOwnerId: user.oneEmployeeOwnerId,
                degraded: true,
            });
        }
    } catch (err) {
        logger.error('status error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * GET /api/crm-bridge/leads
 * Fetches paginated leads for the linked owner from LeadGen.
 * Uses the Owner's _id (oneEmployeeOwnerId) as salesProfileId because
 * leads store createdBy.userId = Owner._id (set when leads were created in LeadGen).
 */
exports.getLeads = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { page, limit, status, search, startDate, endDate } = req.query;
        const params = { page, limit, status, search, startDate, endDate };

        // CRITICAL: query by Owner._id (oneEmployeeOwnerId), NOT HIT User._id
        // Leads in LeadGen have createdBy.userId = Owner._id
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
 */
exports.getLeadById = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        // Use Owner._id for ownership verification (matches createdBy.userId in LeadGen)
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
 */
exports.getAnalytics = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');
        
        console.log({
            linked: user.oneEmployeeLinked,
            ownerId: user.oneEmployeeOwnerId,
        });
        
        if (!user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { startDate, endDate } = req.query;
        const params = { startDate, endDate };

        // Use Owner._id (oneEmployeeOwnerId) — matches createdBy.userId in LeadGen leads
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
