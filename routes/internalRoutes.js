const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Middleware to verify internal secret
const verifyInternalSecret = (req, res, next) => {
    const secret = req.headers['x-internal-secret'];
    const configuredSecret = process.env.INTERNAL_API_SECRET || 'hit-internal-secret-2024';

    if (!secret || secret !== configuredSecret) {
        console.warn('⚠️ Unauthorized internal API access attempt');
        return res.status(403).json({ error: 'Unauthorized: Invalid internal secret' });
    }
    next();
};

// Apply middleware to all routes in this file
router.use(verifyInternalSecret);

/**
 * POST /api/internal/verify-user
 * Verifies if a user exists with specific phone and role
 * Used by lead-filteration backend to allow builder login
 */
router.post('/verify-user', async (req, res) => {
    try {
        const { phone, role } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        console.log(`🔒 Internal Verification Request: Phone=${phone}, Role=${role || 'any'}`);

        // Build query
        const query = { phone: phone };
        if (role) {
            query.role = role;
        }

        const user = await User.findOne(query).select('-password'); // Exclude password if it exists

        if (!user) {
            console.log(`❌ Verification Failed: User not found`);
            return res.status(404).json({ valid: false, message: 'User not found' });
        }

        if (!user.isActive) {
            console.log(`❌ Verification Failed: User is inactive`);
            return res.status(403).json({ valid: false, message: 'User account is inactive' });
        }

        console.log(`✅ Verification Success: ${user.name} (${user.role})`);

        return res.json({
            valid: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                phone: user.phone,
                companyName: user.companyName
            }
        });

    } catch (error) {
        console.error('❌ Internal Verify API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/internal/projects-by-phone/:phone
 * Returns projects owned by a user with the given phone number.
 * Used by lead-filteration backend for Google/FB integration pages.
 */
router.get('/projects-by-phone/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const Project = require('../models/Project');

        console.log(`🔒 Internal Projects Request: Phone=${phone}`);

        const user = await User.findOne({
            phone: phone,
            role: { $in: ['builder', 'agent', 'admin'] }
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found with this phone number' });
        }

        const projects = await Project.find({
            owner: user._id,
            status: { $ne: 'deleted' }
        })
            .select('projectName slug _id coverImage city')
            .sort('createdAt');

        res.status(200).json({
            builder: {
                name: user.name,
                id: user._id
            },
            projects
        });

    } catch (error) {
        console.error('❌ Internal Projects API Error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * GET /api/internal/projects/:hitUserId
 * Returns projects owned by a user with the given HIT User ID.
 * Used by OneEmployee backend for project-based automation.
 */
router.get('/projects/:hitUserId', async (req, res) => {
    try {
        const { hitUserId } = req.params;
        const Project = require('../models/Project');

        const user = await User.findById(hitUserId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const projects = await Project.find({
            owner: user._id,
            status: { $ne: 'deleted' }
        })
            .select('projectName slug _id coverImage city location projectType category reraApproved reraNumber projectStatus pricing configuration amenities cta media status createdAt updatedAt')
            .sort({ createdAt: -1 });

        res.status(200).json({
            builder: {
                name: user.name,
                id: user._id,
                companyName: user.companyName,
                role: user.role
            },
            projects
        });

    } catch (error) {
        console.error('Internal Projects by ID Error:', error);
        res.status(500).json({ message: error.message });
    }
});

/**
 * GET /api/internal/user/:hitUserId
 * Returns basic user info for display in OneEmployee profile.
 */
router.get('/user/:hitUserId', async (req, res) => {
    try {
        const { hitUserId } = req.params;
        const user = await User.findById(hitUserId).select('name phone email role companyName').lean();

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            id: user._id,
            name: user.name,
            phone: user.phone,
            email: user.email,
            role: user.role,
            companyName: user.companyName
        });
    } catch (error) {
        console.error('Internal User Info Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/internal/link-oneemployee
 * Called by OneEmployee when a user confirms linking.
 * Updates the HIT User record with oneEmployeeLinked + oneEmployeeOwnerId.
 */
router.post('/link-oneemployee', async (req, res) => {
    try {
        const { hitUserId, oneEmployeeOwnerId } = req.body;

        if (!hitUserId || !oneEmployeeOwnerId) {
            return res.status(400).json({ error: 'hitUserId and oneEmployeeOwnerId are required' });
        }

        const user = await User.findById(hitUserId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if already linked to a different owner
        if (user.oneEmployeeOwnerId && user.oneEmployeeOwnerId !== oneEmployeeOwnerId) {
            return res.status(409).json({ error: 'User already linked to a different OneEmployee account' });
        }

        await User.findByIdAndUpdate(hitUserId, {
            $set: {
                oneEmployeeLinked: true,
                oneEmployeeOwnerId: oneEmployeeOwnerId
            }
        });

        res.json({ success: true, linked: true });
    } catch (error) {
        console.error('Internal Link OneEmployee Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/internal/unlink-oneemployee
 * Called by OneEmployee when a user unlinks.
 * Clears the HIT User record.
 */
router.post('/unlink-oneemployee', async (req, res) => {
    try {
        const { hitUserId, oneEmployeeOwnerId } = req.body;

        if (!hitUserId) {
            return res.status(400).json({ error: 'hitUserId is required' });
        }

        await User.findByIdAndUpdate(hitUserId, {
            $set: {
                oneEmployeeLinked: false,
                oneEmployeeOwnerId: null
            }
        });

        res.json({ success: true, unlinked: true });
    } catch (error) {
        console.error('Internal Unlink OneEmployee Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/internal/notify-project-update
 * Called internally by HIT Backend's ProjectService after create/update/delete.
 * Notifies all linked OneEmployee owners that their project list changed.
 * Body: { hitUserId, projectId, action: 'created'|'updated'|'deleted', projectName }
 *
 * This is fire-and-forget from the HIT side — doesn't block the project operation.
 */
router.post('/notify-project-update', async (req, res) => {
    try {
        const { hitUserId, projectId, action, projectName } = req.body;

        if (!hitUserId || !projectId || !action) {
            return res.status(400).json({ error: 'hitUserId, projectId, and action are required' });
        }

        // Find if this HIT user has a linked OneEmployee account
        const user = await User.findById(hitUserId).select('oneEmployeeLinked oneEmployeeOwnerId').lean();
        if (!user || !user.oneEmployeeLinked || !user.oneEmployeeOwnerId) {
            // No linked OneEmployee account — nothing to notify
            return res.json({ notified: false, reason: 'no_linked_account' });
        }

        // Send webhook to LeadGen Backend (non-blocking, best-effort)
        const LEADGEN_URL = process.env.LEADGEN_BACKEND_URL || 'https://lead-filteration-backend-624770114041.asia-south1.run.app';
        const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'hit-internal-secret-2024';

        try {
            const axios = require('axios');
            await axios.post(`${LEADGEN_URL}/api/internal/project-sync`, {
                ownerId: user.oneEmployeeOwnerId,
                hitUserId,
                projectId,
                action,
                projectName: projectName || ''
            }, {
                headers: { 'x-internal-secret': INTERNAL_SECRET },
                timeout: 5000
            });
            console.log(`📤 Project update notified to OneEmployee: ${action} ${projectId}`);
        } catch (notifyErr) {
            // Non-blocking — log and continue
            console.warn(`⚠️ Failed to notify OneEmployee of project update:`, notifyErr.message);
        }

        return res.json({ notified: true, action, projectId });
    } catch (error) {
        console.error('notify-project-update Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
