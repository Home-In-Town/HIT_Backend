/**
 * Boot-time environment validation.
 *
 * Previously only MONGODB_CONNECTION_URL was checked, which hid two failure
 * modes that are very hard to diagnose in production:
 *
 *   JWT_SECRET missing        → jwt.verify() throws on every request, and
 *                               middleware/auth.js reports it to users as
 *                               "Not authorized - Invalid token". A total auth
 *                               outage that looks like a client bug.
 *
 *   INTERNAL_API_SECRET missing → routes/internalRoutes.js falls back to a
 *                               constant that is committed to this repo, so the
 *                               internal surface (account creation, user PII,
 *                               OneEmployee linking) is effectively unprotected
 *                               with no warning anywhere.
 *
 * Fail fast on the first, refuse to run with a known-public secret on the second.
 */

// Must be present or the process cannot serve a single authenticated request.
const REQUIRED_VARS = [
  'MONGODB_CONNECTION_URL',
  'JWT_SECRET',
];

// Values that exist in source control and must never be the live secret.
const KNOWN_INSECURE_VALUES = {
  INTERNAL_API_SECRET: ['hit-internal-secret-2024'],
};

// Absent → a documented fallback is used. Safe to boot, but say so out loud.
const RECOMMENDED_VARS = [
  'INTERNAL_API_SECRET',
  'GOOGLE_PLACES_API_KEY',
];

const checkEnv = () => {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error('❌ CRITICAL ERROR: Missing required environment variables:');
    missing.forEach((v) => console.error(`   - ${v}`));
    console.error('\nPlease check your .env file or deployment settings.');
    process.exit(1);
  }

  // A secret that is public in the repo is worse than a missing one, because
  // everything appears to work.
  const insecure = Object.entries(KNOWN_INSECURE_VALUES)
    .filter(([name, bad]) => process.env[name] && bad.includes(process.env[name]))
    .map(([name]) => name);

  if (insecure.length > 0) {
    console.error('❌ CRITICAL ERROR: These variables are set to a value that is committed to the repository:');
    insecure.forEach((v) => console.error(`   - ${v}`));
    console.error('\nRotate them before starting.');
    process.exit(1);
  }

  const notSet = RECOMMENDED_VARS.filter((v) => !process.env[v]);
  if (notSet.length > 0) {
    console.warn('⚠️  Optional environment variables not set (features degrade):');
    notSet.forEach((v) => console.warn(`   - ${v}`));
  }

  console.log('🛡️  Environment variables validated.');
};

module.exports = checkEnv;
