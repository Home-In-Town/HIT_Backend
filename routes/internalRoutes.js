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

module.exports = router;
