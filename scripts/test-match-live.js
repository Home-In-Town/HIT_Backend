/**
 * test-match-live.js
 *
 * Runs the improved MatchEngineV2 against the REAL database with a set of
 * requirements covering each property family present in the data
 * (flat, plot, mixed_use). Prints the top matches + score breakdown so you can
 * eyeball match quality and confirm mixed-use / type handling works end-to-end.
 *
 * Read-only (only runs find() via the engine). No writes.
 *
 * Run: node scripts/test-match-live.js
 */

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const matchEngine = require('../services/MatchEngineV2');
const locationNormalizer = require('./../services/LocationNormalizer');

// Requirements to test — chosen to exercise each family + budget/location.
const REQUIREMENTS = [
  { label: '2BHK flat, Besa, ~55L',        params: { propertyType: 'flat', bhkType: '2BHK', budget: 55, locationRaw: 'Besa' } },
  { label: '3BHK flat, Civil Lines, ~85L', params: { propertyType: 'flat', bhkType: '3BHK', budget: 85, locationRaw: 'Civil Lines' } },
  { label: 'Plot, Wardha Road, ~26L',      params: { propertyType: 'plot', budget: 26, locationRaw: 'Wardha Road' } },
  { label: 'Residential plot ~30L (any loc)', params: { propertyType: 'Residential Plot', budget: 30 } },
  { label: 'Mixed use ~30L (any loc)',     params: { propertyType: 'Residential + Commercial Plot', budget: 30 } },
  { label: 'Commercial plot ~30L',         params: { propertyType: 'Commercial Plot / Land', budget: 30 } },
  { label: 'Flat, no budget, Besa',        params: { propertyType: 'flat', locationRaw: 'Besa' } },
  { label: 'No type, 2BHK ~55L Besa',      params: { bhkType: '2BHK', budget: 55, locationRaw: 'Besa' } },
];

async function run() {
  await connectDB();

  // Load dynamic locations so location scoring works like production.
  try { await locationNormalizer.loadFromProjects(); } catch { /* non-fatal */ }

  for (const rc of REQUIREMENTS) {
    // Enrich location canonical, mirroring how LeadCaptureService does it.
    if (rc.params.locationRaw) {
      const n = locationNormalizer.normalize(rc.params.locationRaw);
      rc.params.locationCanonical = n.canonical;
    }

    const matches = await matchEngine.findMatches(rc.params, { limit: 5, minScore: 20 });

    console.log('\n══════════════════════════════════════════════════════');
    console.log(`REQUIREMENT: ${rc.label}`);
    console.log('──────────────────────────────────────────────────────');
    if (matches.length === 0) {
      console.log('  (no matches ≥ 20)');
      continue;
    }
    matches.forEach((m, i) => {
      const p = m.project;
      const price = p.pricing?.startingPrice ? (p.pricing.startingPrice / 100000).toFixed(0) + 'L' : 'N/A';
      const b = m.breakdown || {};
      console.log(`  ${i + 1}. ${(p.projectName || '?').slice(0, 26).padEnd(26)} | ${(p.location || p.city || '-').slice(0, 18).padEnd(18)} | ${price.padStart(5)}`);
      console.log(`     score=${m.score}  conf=${(m.confidence || 0).toFixed(2)}  type=${p.propertyType || p.category || p.projectType || '-'}`);
      console.log(`     breakdown: budget=${b.budget?.score || 0} location=${b.location?.score || 0}(${b.location?.method || '-'}) type=${b.propertyType?.score || 0}(${b.propertyType?.method || '-'}) bhk=${b.bhk?.score || 0} loan=${b.loan?.score || 0} poss=${b.possession?.score || 0}`);
    });
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error('LIVE TEST ERROR:', err.message); process.exit(1); });
