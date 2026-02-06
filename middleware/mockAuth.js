/**
 * Mock Authentication Middleware
 * 
 * ⚠️ DEVELOPMENT ONLY - Do not use in production!
 * 
 * This middleware reads the `x-mock-user-id` header and attaches the corresponding
 * user to `req.user`. This bypasses real authentication for development purposes.
 * 
 * When you're ready for real auth, replace this with JWT middleware.
 */

const User = require('../models/User');

async function mockAuthMiddleware(req, res, next) {
    const mockUserId = req.headers['x-mock-user-id'];

    // If no mock header is provided, continue without auth (backward compatible)
    if (!mockUserId) {
        req.user = null;
        return next();
    }

    try {
        const user = await User.findById(mockUserId);

        if (!user) {
            return res.status(401).json({
                error: 'Mock user not found',
                hint: 'Run: node scripts/seed-mock-users.js to create mock users'
            });
        }

        // Attach user to request
        req.user = {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            role: user.role
        };

        next();
    } catch (error) {
        console.error('Mock auth error:', error);
        return res.status(500).json({ error: 'Authentication failed' });
    }
}

/**
 * Require a specific role (can be used after mockAuthMiddleware)
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'Access denied',
                required: allowedRoles,
                yourRole: req.user.role
            });
        }

        next();
    };
}

module.exports = { mockAuthMiddleware, requireRole };
