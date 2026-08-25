/**
 * Migration: recompute pricing.pricePerSqFt from pricing.startingPrice and area.
 *
 * The stored pricePerSqFt was hand-entered and frequently drifted out of sync
 * with startingPrice / area (e.g. a card showed 23,000/sqft while price ÷ area
 * worked out to 7,000). The frontend now derives this value at display time, but
 * the stored values are still stale. This script brings the database in line.
 *
 * Derivation mirrors src/utils/pricePerSqFt.ts on the frontend:
 *   - uses the LOWER bound of the area range (to pair with the "starting" price)
 *   - rejects non-sqft units (acres, hectares, etc.) where per-sqft is meaningless
 *   - leaves the value untouched when it can't be reliably derived
 *   - flags (and skips) implausible rates that indicate bad source data — e.g.
 *     Waman Flats derives to ~62,843/sqft, meaning its stored area is wrong.
 *
 * Usage:
 *   node scripts/fix-price-per-sqft.js            # dry run — reports changes only
 *   node scripts/fix-price-per-sqft.js --apply    # writes the corrected values
 */

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Project = require('../models/Project');

const APPLY = process.argv.includes('--apply');

// A per-sqft rate above this almost certainly means the source area (or price)
// is wrong, not the rate. We refuse to write these and flag them for manual review
// rather than replacing one bad number with another.
const IMPLAUSIBLE_RATE = 40000;

/** Parse the lower bound (sqft) from an area range string. Returns null if none/non-sqft. */
function parseAreaLowerBoundSqFt(area) {
  if (!area || typeof area !== 'string') return null;
  const lower = area.toLowerCase();
  if (/\b(acre|acres|hectare|hectares|guntha|bigha)\b/.test(lower)) return null;
  const match = lower.replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const value = parseFloat(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Derive a consistent price-per-sqft. Returns null when it can't be computed. */
function derivePricePerSqFt(price, area) {
  if (!price || !Number.isFinite(price) || price <= 0) return null;
  const areaSqFt = parseAreaLowerBoundSqFt(area);
  if (!areaSqFt) return null;
  const rate = Math.round(price / areaSqFt);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

async function run() {
  await connectDB();

  const projects = await Project.find({})
    .select('projectName status projectStatus pricing.startingPrice pricing.pricePerSqFt configuration.carpetAreaRange configuration.plotSizeRange')
    .lean();

  console.log(`\nScanning ${projects.length} projects (${APPLY ? 'APPLY' : 'DRY RUN'})\n`);

  const toUpdate = [];
  const skipped = [];
  const flagged = [];

  for (const p of projects) {
    const price = p.pricing?.startingPrice;
    const area = p.configuration?.carpetAreaRange || p.configuration?.plotSizeRange;
    const stored = p.pricing?.pricePerSqFt ?? 0;
    const derived = derivePricePerSqFt(price, area);

    if (derived === null) {
      skipped.push({ name: p.projectName, reason: !price ? 'no price' : 'no/invalid area', stored });
      continue;
    }
    if (derived > IMPLAUSIBLE_RATE) {
      flagged.push({ name: p.projectName, published: p.status === 'published', stored, derived, area });
      continue;
    }
    if (derived !== stored) {
      toUpdate.push({ id: p._id, name: p.projectName, published: p.status === 'published', stored, derived });
    }
  }

  console.log(`Mismatched values to correct: ${toUpdate.length}`);
  console.log(`Flagged (bad source data):    ${flagged.length}`);
  console.log(`Skipped (can't derive):       ${skipped.length}\n`);

  if (toUpdate.length) {
    console.log('=== Corrections ===');
    for (const u of toUpdate) {
      const tag = u.published ? '[published]' : '[draft]    ';
      console.log(`  ${tag} ${(u.name || '?').padEnd(30)} ${String(u.stored).padStart(8)} -> ${String(u.derived).padStart(8)}`);
    }
    console.log('');
  }

  if (flagged.length) {
    console.log('=== Flagged: implausible rate, NOT written (verify area/price) ===');
    for (const f of flagged) {
      const tag = f.published ? '[published]' : '[draft]    ';
      console.log(`  ${tag} ${(f.name || '?').padEnd(30)} stored=${String(f.stored).padStart(8)}  derived=${String(f.derived).padStart(8)}  area="${f.area || ''}"`);
    }
    console.log('');
  }

  if (skipped.length) {
    console.log('=== Skipped (left unchanged) ===');
    for (const s of skipped) {
      console.log(`  ${(s.name || '?').padEnd(30)} stored=${String(s.stored).padStart(8)}  (${s.reason})`);
    }
    console.log('');
  }

  if (APPLY && toUpdate.length) {
    const ops = toUpdate.map((u) => ({
      updateOne: {
        filter: { _id: u.id },
        update: { $set: { 'pricing.pricePerSqFt': u.derived } },
      },
    }));
    const result = await Project.bulkWrite(ops);
    console.log(`Applied. Modified ${result.modifiedCount} projects.\n`);
  } else if (!APPLY && toUpdate.length) {
    console.log('Dry run only. Re-run with --apply to write these corrections.\n');
  } else {
    console.log('Nothing to update.\n');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
