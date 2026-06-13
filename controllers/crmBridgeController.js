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
 */
exports.getLeads = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { page, limit, status, search, startDate, endDate } = req.query;
        const params = { page, limit, status, search, startDate, endDate };

        // salesProfileId is the HIT User's _id (stored as Owner.salesProfileId during link)
        const result = await leadGenService.getLeads(req.user._id.toString(), params);
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

        if (!user.oneEmployeeLinked) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const result = await leadGenService.getLeadById(req.params.leadId, req.user._id.toString());
        return res.json(result);
    } catch (err) {
        logger.error('getLeadById error', { error: err.message });
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

        if (!user.oneEmployeeLinked) {
            return res.status(403).json({ error: 'NOT_LINKED' });
        }

        const { startDate, endDate } = req.query;
        const params = { startDate, endDate };

        const result = await leadGenService.getAnalytics(req.user._id.toString(), params);
        return res.json(result);
    } catch (err) {
        logger.error('getAnalytics error', { error: err.message });
        return res.status(err.status || 500).json({ error: err.message });
    }
};

/**
 * POST /api/crm-bridge/sso-token
 * Issues a short-lived SSO token for the linked LeadGen owner.
 */
exports.issueSsoToken = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('oneEmployeeLinked oneEmployeeOwnerId');

        if (!user.oneEmployeeLinked) {
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
