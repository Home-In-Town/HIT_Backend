const express = require('express');
const router = express.Router();
const User = require('../models/User');
const reverseMatchService = require('../services/ReverseMatchService');

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
 * POST /api/internal/create-account
 * Creates a new HIT user account from OneEmployee (pre-verified, no OTP needed).
 * Used when a Phase 1 user wants to enable Phase 2 projects without having a HIT account.
 * Body: { name, phone, mpin (plaintext — will be hashed), email, companyName, oneEmployeeOwnerId }
 */
router.post('/create-account', async (req, res) => {
    try {
        const { name, phone, mpin, email, companyName, oneEmployeeOwnerId } = req.body;

        if (!name || !phone || !mpin) {
            return res.status(400).json({ error: 'name, phone, and mpin are required' });
        }

        // Validate phone (10-digit Indian number)
        const cleanPhone = phone.toString().replace(/\D/g, '');
        if (cleanPhone.length !== 10) {
            return res.status(400).json({ error: 'Phone must be a valid 10-digit Indian number' });
        }

        // Check if phone already exists
        const existing = await User.findOne({ phone: cleanPhone });
        if (existing) {
            return res.status(409).json({
                error: 'An account with this phone number already exists on HomeInTown. Use "Connect" instead.',
                existingUserId: existing._id.toString()
            });
        }

        // Hash MPIN
        const bcrypt = require('bcryptjs');
        const hashedMpin = await bcrypt.hash(mpin.toString(), 12);

        // Create verified user directly (no OTP — OneEmployee already verified)
        const user = await User.create({
            name: name.trim(),
            phone: cleanPhone,
            mpin: hashedMpin,
            email: email?.trim() || undefined,
            companyName: companyName?.trim() || undefined,
            role: 'builder',
            isVerified: true,
            isActive: true,
            // Link back to OneEmployee
            oneEmployeeLinked: true,
            oneEmployeeOwnerId: oneEmployeeOwnerId || undefined,
        });

        console.log(`✅ [Internal] HIT account created from OneEmployee: ${user.name} (${user.phone}) → ${user._id}`);

        res.status(201).json({
            success: true,
            user: {
                id: user._id.toString(),
                name: user.name,
                phone: user.phone,
                role: user.role,
                email: user.email || null,
            }
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: 'Account with this phone already exists' });
        }
        console.error('Internal Create Account Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/internal/projects/:hitUserId
 * Creates a new project in HIT Backend for the given user.
 * Called from OneEmployee when a user adds a project from their dashboard.
 */
router.post('/projects/:hitUserId', async (req, res) => {
    try {
        const { hitUserId } = req.params;
        const Project = require('../models/Project');
        const slugify = require('../utils/slugify');

        const user = await User.findById(hitUserId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const status = req.body.status || 'draft';

        // ── Validation for publishing — same rules as HIT frontend ───────
        if (status === 'published') {
            const errors = [];
            if (!req.body.projectName || !req.body.projectName.trim()) errors.push('Project name is required');
            if (!req.body.category) errors.push('Category is required');
            if (!req.body.city || !req.body.city.trim()) errors.push('City is required');
            if (!req.body.location || !req.body.location.trim()) errors.push('Location / Area is required');
            if (!req.body.projectType && !req.body.propertyType) errors.push('Property type is required');
            if (!req.body.pricing?.startingPrice && !req.body.pricing?.pricePerSqFt) errors.push('At least one pricing field is required (Starting Price or Price Per Sq Ft)');
            if (!req.body.cta?.whatsappNumber && !req.body.cta?.callNumber) errors.push('At least one contact number is required (WhatsApp or Call)');

            if (errors.length > 0) {
                return res.status(400).json({ error: 'Cannot publish — missing required fields', details: errors });
            }
        }

        const projectData = {
            ...req.body,
            owner: user._id,
            status,
        };

        // Generate slug for published projects (required for public visibility on homeintown.in)
        if (status === 'published' && req.body.projectName) {
            projectData.slug = slugify(req.body.projectName.trim());
            // Check if slug already exists, append random suffix if collision
            const existing = await Project.findOne({ slug: projectData.slug });
            if (existing) {
                projectData.slug = `${projectData.slug}-${Date.now().toString(36).slice(-4)}`;
            }
        }

        const project = await Project.create(projectData);
        console.log(`✅ [Internal] Project created from OneEmployee: ${project.projectName} (${project._id}) status=${project.status} slug=${project.slug || 'none'} for user ${user.name}`);

        // Fire-and-forget: reverse match if published
        if (project.status === 'published') {
          const fullProject = await Project.findById(project._id)
            .populate('owner', 'name companyName role verificationStatus')
            .lean();
          const io = req.app.get('io');
          reverseMatchService.onProjectPublished(fullProject, io).catch(err => {
            console.error('ReverseMatch (internal create) non-blocking error:', err.message);
          });
        }

        res.status(201).json({
            success: true,
            project: {
                _id: project._id,
                projectName: project.projectName,
                projectType: project.projectType,
                city: project.city,
                location: project.location,
                category: project.category,
                status: project.status,
                slug: project.slug,
                createdAt: project.createdAt,
            }
        });
    } catch (error) {
        if (error.name === 'ValidationError') {
            return res.status(400).json({ error: 'Validation failed', details: Object.values(error.errors).map(e => e.message) });
        }
        console.error('Internal Create Project Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/internal/projects/:hitUserId/:projectId
 * Updates an existing project from OneEmployee.
 */
router.put('/projects/:hitUserId/:projectId', async (req, res) => {
    try {
        const { hitUserId, projectId } = req.params;
        const Project = require('../models/Project');
        const slugify = require('../utils/slugify');

        const user = await User.findById(hitUserId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // If status is being changed to 'published', validate and generate slug
        if (req.body.status === 'published') {
            const existingProject = await Project.findOne({ _id: projectId, owner: user._id }).lean();
            if (!existingProject) return res.status(404).json({ error: 'Project not found' });

            // Merge existing data with incoming update for validation
            const merged = { ...existingProject, ...req.body };
            const errors = [];
            if (!merged.projectName || !merged.projectName.trim()) errors.push('Project name is required');
            if (!merged.category) errors.push('Category is required');
            if (!merged.city || !merged.city.trim()) errors.push('City is required');
            if (!merged.location || !merged.location.trim()) errors.push('Location / Area is required');
            if (!merged.pricing?.startingPrice && !merged.pricing?.pricePerSqFt) errors.push('At least one pricing field is required');
            if (!merged.cta?.whatsappNumber && !merged.cta?.callNumber) errors.push('At least one contact number is required');

            if (errors.length > 0) {
                return res.status(400).json({ error: 'Cannot publish — missing required fields', details: errors });
            }

            // Generate slug if not already present
            if (!existingProject.slug) {
                req.body.slug = slugify((merged.projectName || '').trim());
                const slugExists = await Project.findOne({ slug: req.body.slug, _id: { $ne: projectId } });
                if (slugExists) {
                    req.body.slug = `${req.body.slug}-${Date.now().toString(36).slice(-4)}`;
                }
            }
        }

        const project = await Project.findOneAndUpdate(
            { _id: projectId, owner: user._id },
            { $set: req.body },
            { new: true, runValidators: true }
        );

        if (!project) return res.status(404).json({ error: 'Project not found or not owned by this user' });

        console.log(`✅ [Internal] Project updated from OneEmployee: ${project.projectName} (${project._id}) status=${project.status}`);

        // Fire-and-forget: reverse match if status changed to published
        if (req.body.status === 'published') {
          const fullProject = await Project.findById(project._id)
            .populate('owner', 'name companyName role verificationStatus')
            .lean();
          const io = req.app.get('io');
          reverseMatchService.onProjectPublished(fullProject, io).catch(err => {
            console.error('ReverseMatch (internal update) non-blocking error:', err.message);
          });
        }

        res.json({ success: true, project });
    } catch (error) {
        if (error.name === 'ValidationError') {
            return res.status(400).json({ error: 'Validation failed', details: Object.values(error.errors).map(e => e.message) });
        }
        console.error('Internal Update Project Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/internal/projects/:hitUserId/:projectId
 * Deletes (soft) a project from OneEmployee.
 */
router.delete('/projects/:hitUserId/:projectId', async (req, res) => {
    try {
        const { hitUserId, projectId } = req.params;
        const Project = require('../models/Project');

        const user = await User.findById(hitUserId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const project = await Project.findOneAndUpdate(
            { _id: projectId, owner: user._id },
            { $set: { status: 'deleted' } },
            { new: true }
        );

        if (!project) return res.status(404).json({ error: 'Project not found or not owned by this user' });

        console.log(`🗑️ [Internal] Project deleted from OneEmployee: ${project.projectName} (${project._id})`);
        res.json({ success: true, message: 'Project deleted' });
    } catch (error) {
        console.error('Internal Delete Project Error:', error);
        res.status(500).json({ error: error.message });
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

        // Return ALL non-deleted projects for this user's account
        // Admin/builder on HIT can see all projects in their dashboard — mirror that here
        const projects = await Project.find({
            status: { $ne: 'deleted' }
        })
            .select('projectName slug _id coverImage city location projectType category reraApproved reraNumber projectStatus pricing configuration amenities cta media status owner createdAt updatedAt')
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
 * GET /api/internal/user-by-phone/:phone
 * Looks up a HIT user by phone number.
 * Returns basic info or 404 if not found.
 */
router.get('/user-by-phone/:phone', async (req, res) => {
    try {
        const phone = req.params.phone.replace(/\D/g, '');
        const user = await User.findOne({ phone }).select('_id name phone email role isVerified').lean();
        if (!user) return res.status(404).json({ error: 'No account found with this phone' });
        res.json({ id: user._id.toString(), name: user.name, phone: user.phone, email: user.email, role: user.role });
    } catch (error) {
        console.error('Internal user-by-phone error:', error);
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
