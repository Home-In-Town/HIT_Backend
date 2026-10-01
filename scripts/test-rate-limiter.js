/**
 * Rate limiter — behaviour test over real HTTP
 *
 * Exercises the REAL exports of middleware/rateLimiter.js on a throwaway express
 * app shaped like server.js (express.json -> trust proxy -> req.userId extraction
 * -> generalLimiter -> /api/auth router with authLimiter + one ordinary router).
 *
 * WHY THIS EXISTS
 * Every bug this file guards against failed SILENTLY in production — nothing threw,
 * the limiter just did the wrong thing:
 *   - the limiter sat in front of /api/auth/*, so a user who burned the general
 *     window could not log back in (30 Sep / 1 Oct 2026: 87 x 429, all okhttp/4.9.2)
 *   - the cap was 100 per 15 min (~6.6/min) against 37-42 req/min of normal use
 *   - keyGenerator called ipKeyGenerator(req) instead of ipKeyGenerator(req.ip), so
 *     the key was the request OBJECT, never matched across requests, and the IP
 *     fallback bucket limited nothing at all
 *   - validate: { xForwardedForHeader: false } hid the warning that would have
 *     reported `trust proxy` being unset
 * So the cap is read from the RateLimit-Policy header rather than hardcoded here,
 * two client IPs are checked for independent buckets, and console.error is captured
 * for the whole run to prove no validation check is firing.
 *
 * No database and no network egress — only loopback HTTP on an ephemeral port.
 *
 * USAGE
 *   node scripts/test-rate-limiter.js
 */

'use strict';

const http = require('http');
const express = require('express');
const { generalLimiter, authLimiter } = require('../middleware/rateLimiter');

let passed = 0;
let failed = 0;

// Captured for assertion (g): express-rate-limit reports every failed validation
// check through console.error, so a clean capture is the proof that removing
// validate: { xForwardedForHeader: false } did not just trade one silent problem
// for another.
const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map(String).join(' '));
};

function section(name) {
  console.log(`\n${'─'.repeat(72)}\n${name}\n${'─'.repeat(72)}`);
}

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── App under test (mirrors server.js's middleware order) ───────────────────

function buildApp() {
  const app = express();
  app.use(express.json());

  // Same single-hop trust as production Cloud Run, so a one-entry X-Forwarded-For
  // becomes req.ip and each test client gets its own bucket.
  app.set('trust proxy', 1);

  // Stands in for server.js's JWT pre-extraction middleware.
  app.use((req, res, next) => {
    if (req.headers['x-test-user-id']) req.userId = req.headers['x-test-user-id'];
    next();
  });

  app.use(generalLimiter);

  const authRouter = express.Router();
  authRouter.post('/login', authLimiter, (req, res) => res.json({ ok: true, route: 'login' }));
  app.use('/api/auth', authRouter);

  const itemsRouter = express.Router();
  itemsRouter.get('/', (req, res) => res.json({ ok: true, route: 'items' }));
  app.use('/api/items', itemsRouter);

  return app;
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

// One socket, reused: ~2000 sequential requests go through here.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function send(port, { method = 'GET', path = '/api/items/', ip, userId, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    // Single-entry X-Forwarded-For is what Cloud Run actually delivers — it
    // overwrites the header with the one client IP rather than appending.
    if (ip) headers['X-Forwarded-For'] = ip;
    if (userId) headers['X-Test-User-Id'] = userId;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (err) { /* keep raw text */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// draft-7 emits `RateLimit-Policy: 1000;w=900`.
function parsePolicy(value) {
  const match = /^\s*(\d+)\s*;\s*w=(\d+)/.exec(value || '');
  return match ? { limit: Number(match[1]), windowSeconds: Number(match[2]) } : null;
}

// draft-7 emits `RateLimit: limit=1000, remaining=999, reset=900`.
function parseRemaining(value) {
  const match = /remaining=(\d+)/.exec(value || '');
  return match ? Number(match[1]) : null;
}

(async () => {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // ─── A. The shipped policy, read from the wire ───────────────────────────
    section('A. Policy advertised by generalLimiter');

    const probe = await send(port, { ip: '203.0.113.1' });
    const policy = parsePolicy(probe.headers['ratelimit-policy']);
    ok('RateLimit-Policy header is present', policy !== null,
      `raw: ${probe.headers['ratelimit-policy']}`);

    const limit = policy ? policy.limit : 0;
    eq('the cap is the raised 1000 per window', limit, 1000);
    eq('the window is still 15 minutes (900s)', policy && policy.windowSeconds, 900);

    // ─── B. /api/auth/* is exempt from the general limiter ───────────────────
    section('B. Auth routes skip the general limiter');

    const authIp = '203.0.113.11';
    let authNon200 = 0;
    const authPolicies = new Set();
    for (let i = 0; i < limit + 1; i++) {
      const res = await send(port, {
        method: 'POST',
        path: '/api/auth/login',
        ip: authIp,
        body: { phone: '+91 98765 43210' },
      });
      if (res.status !== 200) authNon200++;
      authPolicies.add(res.headers['ratelimit-policy']);
    }
    eq(`all ${limit + 1} POSTs to /api/auth/login succeeded (more than the cap)`, authNon200, 0);
    // The auth route still advertises a policy, but it is authLimiter's own
    // (1h / 10 failures, successes skipped) — the general policy never appears,
    // which is how we know generalLimiter skipped the request entirely.
    ok('the only policy advertised there is authLimiter\'s, not the general one',
      !authPolicies.has(`${limit};w=900`),
      `observed: ${[...authPolicies].join(' | ')}`);

    const afterAuth = await send(port, { ip: authIp });
    eq('the same client then reaches a non-auth route', afterAuth.status, 200);
    eq('with its full allowance untouched',
      parseRemaining(afterAuth.headers.ratelimit), limit - 1);

    // ─── C. A non-auth route is limited at exactly the cap ───────────────────
    section('C. Non-auth routes are limited at the cap');

    const limitedIp = '203.0.113.21';
    let successes = 0;
    let firstBlockedAt = null;
    let blocked = null;
    for (let i = 1; i <= limit + 1; i++) {
      const res = await send(port, { ip: limitedIp });
      if (res.status === 200) {
        successes++;
      } else if (firstBlockedAt === null) {
        firstBlockedAt = i;
        blocked = res;
      }
    }
    eq(`exactly ${limit} requests were allowed`, successes, limit);
    eq('request number cap+1 was the first to be blocked', firstBlockedAt, limit + 1);
    eq('it was rejected with 429', blocked && blocked.status, 429);
    eq('and carried the configured message body', blocked && blocked.body,
      { error: 'Too many requests, please try again later.' });

    const retryAfter = blocked && blocked.headers['retry-after'];
    ok('the 429 carries a numeric Retry-After (seconds)',
      retryAfter !== undefined && retryAfter !== '' && Number.isFinite(Number(retryAfter)),
      `retry-after: ${retryAfter}`);

    // ─── D. Per-IP buckets are independent ──────────────────────────────────
    // The regression guard for ipKeyGenerator(req) -> ipKeyGenerator(req.ip): with
    // the old call the key was the request object, so nothing was ever counted.
    section('D. Different client IPs get independent buckets');

    const otherIp = '203.0.113.22';
    const other = await send(port, { ip: otherIp });
    eq('a second client IP is not affected by the first one being blocked', other.status, 200);
    eq('and starts with a full window of its own',
      parseRemaining(other.headers.ratelimit), limit - 1);

    const stillBlocked = await send(port, { ip: limitedIp });
    eq('while the exhausted IP is still blocked', stillBlocked.status, 429);

    // ─── E. Authenticated callers key off the user, not the IP ──────────────
    section('E. req.userId keys separately from the IP');

    const asUser = await send(port, { ip: limitedIp, userId: 'test-user-1' });
    eq('a logged-in user on the exhausted IP is allowed through', asUser.status, 200);
    eq('because it is a fresh user_<id> bucket',
      parseRemaining(asUser.headers.ratelimit), limit - 1);

    // ─── F. No validation check is firing ───────────────────────────────────
    section('F. express-rate-limit validation is silent');

    eq('nothing was written to console.error during the run', consoleErrors, []);
  } finally {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
    console.error = realConsoleError;
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(72));
  if (failed === 0) {
    console.log('\nNote: counters here are the default in-memory store, i.e. per process.');
    console.log('In production they are per Cloud Run INSTANCE — see the header comment');
    console.log('in middleware/rateLimiter.js.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error = realConsoleError;
  console.error('\nTest run crashed:', err.message, '\n', err.stack);
  process.exit(1);
});
