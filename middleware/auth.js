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
            return res.status(401).json({ error: 'Not authorized - No token provided' });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Fetch user from DB to ensure they still exist and are active
        const user = await User.findById(decoded.id).select('-mpin');

        if (!user) {
            return res.status(401).json({ error: 'Not authorized - User not found' });
        }

        if (!user.isActive) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Add user info to request
        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Session expired - Please login again' });
        }
        res.status(401).json({ error: 'Not authorized - Invalid token' });
    }
};

/**
 * Role-based authorization middleware.
 * @param {...string} roles - List of allowed roles.
 */
exports.restrictTo = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
};
