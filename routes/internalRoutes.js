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

module.exports = router;
