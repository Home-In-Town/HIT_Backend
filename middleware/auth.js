const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Protect route with JWT verification from HTTP-Only Cookie.
 */
exports.protect = async (req, res, next) => {
    try {
        let token;

        // Check for token in cookies
        if (req.cookies && req.cookies.token) {
            token = req.cookies.token;
        }

        if (!token) {
            console.log('❌ Auth: No token found');
            return res.status(401).json({ error: 'Not authorized - No token provided' });
        }

        // Verify token
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Fetch user from DB to ensure they still exist and are active
            const user = await User.findById(decoded.id)
                .select('-mpin')
                .populate('employerId', 'name phone role');

            if (!user) {
                console.log('❌ Auth: User from token not found in DB');
                return res.status(401).json({ error: 'Not authorized - User not found' });
            }

            if (!user.isActive) {
                console.log('❌ Auth: User from token is deactivated');
                return res.status(403).json({ error: 'Account is deactivated' });
            }

            // Add user info to request
            req.user = user;
            next();
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                console.log('❌ Auth: JWT Token Expired');
                return res.status(401).json({ error: 'Session expired - Please login again' });
            }
            console.log('❌ Auth: Invalid JWT Token:', error.message);
            res.status(401).json({ error: 'Not authorized - Invalid token' });
        }
    } catch (globalError) {
        console.error('🔥 Auth: Unexpected Error in Protect Middleware:', globalError);
        res.status(500).json({ error: 'Internal Server Error during authentication' });
    }
};

/**
 * Role-based authorization middleware.
 * @param {...string} roles - List of allowed roles.
 */
exports.restrictTo = (...roles) => {
    return (req, res, next) => {
        console.log("User role:", req.user.role);
        console.log("Allowed roles:", roles);

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: "Insufficient permissions",
                userRole: req.user.role,
                allowedRoles: roles,
            });
        }

        next();
    };
};
