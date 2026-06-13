#!/usr/bin/env node
/**
 * smoke-test-crm.js
 * -----------------
 * CRM Integration Smoke Test Script
 *
 * AUTOMATED: Verifies required environment variables are present and non-empty.
 * MANUAL: Documents the end-to-end integration test flows that must be run
 *         against a live environment (cannot be automated here because they
 *         require running server instances and real MongoDB data).
 *
 * Usage:
 *   node scripts/smoke-test-crm.js
 *
 * Run from the HIT_Backend directory. Loads .env.local if present, falls back
 * to .env so you can run against either local or production config.
 *
 * Requirements covered: 19.1, 19.2, 19.3, 19.4, 21.1, 21.2, 21.3
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Load env file (prefer .env.local, then .env)
// ---------------------------------------------------------------------------
const envLocal = path.join(__dirname, '..', '.env.local');
const envProd  = path.join(__dirname, '..', '.env');

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already defined (process.env takes precedence)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

if (fs.existsSync(envLocal)) {
  loadDotenv(envLocal);
  console.log('ℹ  Loaded: .env.local');
} else {
  loadDotenv(envProd);
  console.log('ℹ  Loaded: .env');
}

// ---------------------------------------------------------------------------
// Required env vars for CRM integration
// ---------------------------------------------------------------------------
const REQUIRED_VARS = [
  {
    key:    'LEADGEN_BACKEND_URL',
    desc:   'Base URL of the LeadGen (OneEmployee) Backend',
    example: 'https://lead-filteration-backend-624770114041.asia-south1.run.app',
  },
  {
    key:    'INTERNAL_API_SECRET',
    desc:   'Shared secret for server-to-server calls between HIT_Backend and LeadGen_Backend',
    example: 'hit-internal-secret-2024',
  },
  {
    key:    'JWT_SECRET',
    desc:   'Shared JWT signing secret — must match LeadGen_Backend JWT_SECRET',
    example: 'hit-sales-secret-2024',
  },
];

// ---------------------------------------------------------------------------
// Run automated env var check
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════════════');
console.log('  CRM Integration — Environment Variable Check   ');
console.log('══════════════════════════════════════════════════\n');

let allPresent = true;

for (const v of REQUIRED_VARS) {
  const value = process.env[v.key];
  if (value && value.trim() !== '') {
    const masked = value.length > 8
      ? value.slice(0, 4) + '****' + value.slice(-4)
      : '****';
    console.log(`  ✅  ${v.key} = ${masked}`);
  } else {
    console.warn(`  ❌  ${v.key} is MISSING or empty`);
    console.warn(`       ${v.desc}`);
    console.warn(`       Example: ${v.key}=${v.example}\n`);
    allPresent = false;
  }
}

console.log('');

if (allPresent) {
  console.log('✅  CRM integration env vars: OK\n');
} else {
  console.error('❌  One or more required env vars are missing. See warnings above.\n');
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Manual test flow documentation
// ---------------------------------------------------------------------------
console.log('══════════════════════════════════════════════════');
console.log('  Manual Integration Test Flows (Req 19.1–19.4)  ');
console.log('══════════════════════════════════════════════════');

console.log(`
These flows require both HIT_Backend and LeadGen_Backend to be running and
connected to their respective MongoDB instances.

─────────────────────────────────────────────────────────────────────────────
FLOW 1 — Link → Leads  (Requirements 19.1, 19.2, 21.1, 21.2, 21.3)
─────────────────────────────────────────────────────────────────────────────
1. Log in to HIT: POST /api/auth/login  →  receive JWT cookie.

2. Check initial status:
   GET /api/crm-bridge/status
   Expected: { linked: false }

3. Link account (use a phone/email that exists as a LeadGen Owner):
   POST /api/crm-bridge/link
   Body: { "phoneOrEmail": "<owner_phone_or_email>" }
   Expected: { linked: true, ownerEmail: "...", ownerPhone: "..." }

4. Confirm status is now linked:
   GET /api/crm-bridge/status
   Expected: { linked: true, oneEmployeeOwnerId: "...", connectedEmail: "...", connectedPhone: "..." }

5. Fetch paginated leads:
   GET /api/crm-bridge/leads?page=1&limit=20
   Expected: { leads: [...], total: N, page: 1, pages: M }

6. Verify query params are forwarded:
   GET /api/crm-bridge/leads?status=HOT&search=test&startDate=2024-01-01&endDate=2024-12-31
   Expected: filtered results without server error.

─────────────────────────────────────────────────────────────────────────────
FLOW 2 — SSO Deep-Link  (Requirements 10.1–10.7, 19.4)
─────────────────────────────────────────────────────────────────────────────
Prerequisite: HIT user is linked (see Flow 1, step 3).

1. Request SSO token:
   POST /api/crm-bridge/sso-token
   Body: { "redirectPath": "/leads" }
   Expected: { token: "<jwt>", expiresIn: 300 }

2. Navigate browser to:
   ${process.env.LEADGEN_BACKEND_URL || '<LEADGEN_BACKEND_URL>'}/api/sso/validate?token=<jwt>&redirect=/leads
   
   Expected sequence:
   a. LeadGen verifies token signature.
   b. LeadGen checks purpose === 'sso'.
   c. LeadGen sets a 30-day httpOnly session cookie.
   d. Browser is redirected to https://oneemployee.in/leads (no login prompt).

3. Verify SSO token CANNOT be used as a session token:
   GET /api/anything  (on LeadGen, with Authorization: Bearer <sso_jwt>)
   Expected: HTTP 401  { error: 'SSO tokens cannot be used as session tokens.' }

─────────────────────────────────────────────────────────────────────────────
FLOW 3 — Degraded Mode  (Requirement 5.3, 19.3)
─────────────────────────────────────────────────────────────────────────────
Prerequisite: HIT user is linked.

1. Temporarily set LEADGEN_BACKEND_URL to an unreachable address
   (e.g., http://localhost:9999) and restart HIT_Backend.

2. Call:
   GET /api/crm-bridge/status
   Expected: 200  { linked: true, ..., degraded: true }
   Must NOT return 500 or an error body.

3. Restore LEADGEN_BACKEND_URL and restart HIT_Backend.

─────────────────────────────────────────────────────────────────────────────
FLOW 4 — Backward Compatibility  (Requirements 19.1, 19.2)
─────────────────────────────────────────────────────────────────────────────
1. Exercise all pre-existing HIT routes and confirm responses are unchanged:
   - GET  /api/projects          → same shape as before
   - POST /api/auth/login        → same shape
   - GET  /api/analytics/...     → same shape

2. Exercise all pre-existing LeadGen routes and confirm they work unchanged:
   - GET  /api/leads             → same shape
   - POST /api/owners/...        → same shape

3. Confirm the protect middleware rejects SSO tokens:
   - Issue a SSO token via POST /api/crm-bridge/sso-token.
   - Use that token as a Bearer token on any LeadGen protected route.
   - Expected: 401  { error: 'SSO tokens cannot be used as session tokens.' }
`);

console.log('══════════════════════════════════════════════════\n');
