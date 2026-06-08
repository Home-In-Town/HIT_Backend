const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Normalizes phone numbers by stripping all non-digit characters.
 * Prevents bypass via format variations (+91, spaces, dashes).
 */
const normalizePhone = (phone) => {
    if (typeof phone !== 'string') return null;
    const digits = phone.replace(/\D/g, '');
    return digits.length > 0 ? digits : null;
};

/**
 * General Key Generator (Used for most API routes)
 * Prioritizes Authenticated User ID (Tier 1) to prevent collective IP blocking.
 */
const generalKeyGenerator = (req) => {
    if (req.userId) return `user_${req.userId}`;

    const phone = normalizePhone(req.body?.phone);
    if (phone) return `auth_${phone}`;

    // Use ipKeyGenerator to properly handle IPv6 addresses (avoids ERR_ERL_KEY_GEN_IPV6)
    return ipKeyGenerator(req);
};

/**
 * Auth Key Generator (Specifically for register/login/forgot-mpin)
 * Prioritizes Phone Number (Tier 2) to prevent an authenticated attacker
 * from brute-forcing someone else's account.
 */
const authKeyGenerator = (req) => {
    const phone = normalizePhone(req.body?.phone);
    if (phone) return `auth_${phone}`;

    if (req.userId) return `user_${req.userId}`;

    // Use ipKeyGenerator to properly handle IPv6 addresses (avoids ERR_ERL_KEY_GEN_IPV6)
    return ipKeyGenerator(req);
};

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    keyGenerator: generalKeyGenerator,
    // Skip validation warning — we call ipKeyGenerator correctly inside keyGenerator
    validate: { xForwardedForHeader: false },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 authentication attempts per hour per phone/account
    keyGenerator: authKeyGenerator,
    skipSuccessfulRequests: true, // Only count failed attempts (prevents lockout of active users)
    // Skip validation warning — we call ipKeyGenerator correctly inside keyGenerator
    validate: { xForwardedForHeader: false },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again in an hour.' }
});

module.exports = { generalLimiter, authLimiter };


