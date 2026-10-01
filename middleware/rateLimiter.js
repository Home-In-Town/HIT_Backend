/**
 * KNOWN LIMITATION — counters are per Cloud Run INSTANCE, not per service.
 *
 * express-rate-limit is running on its default in-memory store, so every
 * counter lives inside the process that handled the request. Today the service
 * usually runs a single instance so the numbers below behave as written, but the
 * moment Cloud Run scales out, each instance keeps its own independent counters:
 * a user whose requests are spread across N instances effectively gets N x the
 * cap, and the same user can be limited on one request and waved through on the
 * next depending on which instance answered. That also means LOWERING a limit
 * here does not reliably tighten anything — the effective cap is whatever the
 * instance count multiplies it to. The real fix is a shared counter
 * (rate-limit-redis against Cloud Memorystore, or any central store), which is
 * new infrastructure and deliberately NOT part of this change; no dependency was
 * added for it. Treat it as the required follow-up before any limit here is
 * lowered again, because until then a tightened limit is only a suggestion.
 */

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

    // ipKeyGenerator's v8 signature is ipKeyGenerator(ip: string, ipv6Subnet?) — it
    // normalizes IPv6 into a /56 subnet so a single host cannot rotate addresses.
    // This previously passed the whole `req`, which returned the request OBJECT as
    // the key; the store could never match that across requests, so the IP fallback
    // bucket never limited anything (measured: 6/6 requests passed with max 2, vs
    // 200 200 429 429 429 429 once a string is passed). This is a keying fix, not a
    // policy change — but it ACTIVATES a bucket that until now never fired, so
    // anonymous callers start being counted for the first time.
    return ipKeyGenerator(req.ip);
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

    // Same defect as in generalKeyGenerator: ipKeyGenerator takes an IP STRING, and
    // passing `req` produced a key the store could never match, so this fallback
    // never limited a single request. Keying fix only; it activates a dormant bucket.
    return ipKeyGenerator(req.ip);
};

// Both limiters used to pass `validate: { xForwardedForHeader: false }`, nominally
// to hush a warning "because we call ipKeyGenerator correctly". That silenced
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR — the one check that would have reported an
// X-Forwarded-For header arriving while `trust proxy` was unset, i.e. exactly the
// misconfiguration that collapsed every anonymous caller into one bucket. The
// suppression is gone and server.js now sets trust proxy, so the check passes on
// its own merits instead of being hidden.
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // Raised from 100 to 1000 (~66 req/min). Observed peak NORMAL use is 37-42
    // req/min, so the old 100 per 15 min (~6.6/min) was below what app startup
    // alone costs, and a heavy 15-minute session reaches several hundred requests.
    // Every request counted — there is deliberately no skipSuccessfulRequests here,
    // because the point of a general limiter is to cap total volume — and the
    // limiter also sat in front of /api/auth/*, so a user who burned the window
    // could not log back in. Production: 30 Sep 2026 saw 112 requests 08:05-08:18
    // UTC then 39 x 429 across 08:19-08:24 (three of them on POST /api/auth/login),
    // recovering only at 08:29 when the window rolled; 1 Oct 2026 saw 89 requests
    // 16:24-16:29 then 28 of 42 requests 429 at 16:30 and 17 of 17 at 16:31. All 87
    // observed 429s carried user agent okhttp/4.9.2 — the Android app, no browser
    // traffic at all. 1000 leaves real headroom while still stopping a runaway
    // render loop or a script.
    max: 1000,
    keyGenerator: generalKeyGenerator,
    // Auth routes are exempt from the GENERAL limiter so that burning the general
    // window can never lock a user out of logging in — the previous arrangement
    // turned a burst of ordinary reads into "cannot sign in for 15 minutes". Brute
    // force protection is not lost: authLimiter still guards register/login/
    // forgot-mpin/reset-mpin with its own 1h/10-failures policy. req.path at the
    // app-level mount INCLUDES the /api prefix (measured '/api/auth/login', with
    // req.baseUrl ''), so the prefix test must carry /api.
    skip: (req) => req.path.startsWith('/api/auth/'),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 authentication attempts per hour per phone/account
    keyGenerator: authKeyGenerator,
    skipSuccessfulRequests: true, // Only count failed attempts (prevents lockout of active users)
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again in an hour.' }
});

module.exports = { generalLimiter, authLimiter };


