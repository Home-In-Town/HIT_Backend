/**
 * Migration: extend lead retention + remove duplicate chat leads.
 *
 * Two problems this fixes in existing data:
 *
 * 1. RETENTION. `expiresAt` used to default to 15 days, backed by a TTL index
 *    that HARD-DELETES the document. Every existing lead therefore still carries
 *    a short expiry and will vanish — including buy requirements that are meant
 *    to be reusable, and the 180-day pool ReverseMatchService searches when a new
 *    project is published. The model default is now 730 days; this pushes already
 *    stored leads forward to the same window.
 *
 * 2. DUPLICATES. confirmLead had no idempotency guard, so every extra tap on
 *    "Confirm & Find Matches" persisted another identical lead. The guard is in
 *    place now; this clears the rows it already created, keeping the OLDEST of
 *    each group (it holds the original match results).
 *
 * Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   node scripts/migrateLeadRetention.js --dry-run
 *   node scripts/migrateLeadRetention.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const ExtractedLead = require('../models/ExtractedLead');

const DRY_RUN = process.argv.includes('--dry-run');
const RETENTION_DAYS = ExtractedLead.LEAD_RETENTION_DAYS || 730;

function log(...a) { console.log(...a); }
function section(t) { log(`\n${'-'.repeat(68)}\n${t}\n${'-'.repeat(68)}`); }

(async () => {
  log('Connecting...');
  await connectDB();
  if (DRY_RUN) log('\nDRY RUN - no writes\n');

  // ─── Audit before ────────────────────────────────────────────────────────
  section('BEFORE');
  const total = await ExtractedLead.countDocuments({});
  const soon30 = await ExtractedLead.countDocuments({ expiresAt: { $lt: new Date(Date.now() + 30 * 86400000) } });
  const soon180 = await ExtractedLead.countDocuments({ expiresAt: { $lt: new Date(Date.now() + 180 * 86400000) } });
  const byDir = await ExtractedLead.aggregate([
    { $group: { _id: '$direction', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]);
  log(`total leads                      : ${total}`);
  log(`expiring within 30 days          : ${soon30}`);
  log(`expiring within 180 days         : ${soon180}`);
  log(`by direction                     : ${byDir.map(d => `${d._id}=${d.n}`).join(', ')}`);

  // ─── 1. Duplicates ───────────────────────────────────────────────────────
  // Grouped by (originalText, extractedBy, direction). Identical text from the
  // same user in the same direction is a repeated confirm, not two real leads.
  section('DUPLICATE CHAT LEADS');
  const groups = await ExtractedLead.aggregate([
    { $match: { source: 'direct_chat' } },
    {
      $group: {
        _id: { text: '$originalText', by: '$extractedBy', dir: '$direction' },
        n: { $sum: 1 },
        docs: { $push: { id: '$_id', createdAt: '$createdAt', matchCount: '$matchCount' } },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);

  let removed = 0;
  const toDelete = [];
  for (const g of groups) {
    // Keep the oldest; it carries the original match results.
    const sorted = g.docs.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const keep = sorted[0];
    const drop = sorted.slice(1);
    toDelete.push(...drop.map(d => d.id));
    removed += drop.length;
    const label = String(g._id.text || '').slice(0, 60);
    log(`  "${label}" x${g.n} -> keep ${keep.id}, drop ${drop.length}`);
  }
  log(`\n  duplicate groups: ${groups.length}, rows to remove: ${removed}`);

  if (!DRY_RUN && toDelete.length) {
    const res = await ExtractedLead.deleteMany({ _id: { $in: toDelete } });
    log(`  deleted ${res.deletedCount}`);
  }

  // ─── 2. Retention backfill ───────────────────────────────────────────────
  // Applied AFTER dedupe so we don't extend rows we're about to delete.
  section('RETENTION BACKFILL');
  const cutoff = new Date(Date.now() + RETENTION_DAYS * 86400000);
  const stale = await ExtractedLead.countDocuments({
    $or: [{ expiresAt: { $lt: cutoff } }, { expiresAt: { $exists: false } }, { expiresAt: null }],
  });
  log(`  leads to extend to ${RETENTION_DAYS} days: ${stale}`);

  if (!DRY_RUN && stale > 0) {
    // Anchored to createdAt so a lead's lifetime is measured from capture, not
    // from when this migration happened to run.
    // Uses the native driver: Mongoose refuses an aggregation-pipeline update
    // unless explicitly told, and the pipeline form is what lets us compute the
    // new date per-document from its own createdAt.
    const res = await ExtractedLead.collection.updateMany(
      { $or: [{ expiresAt: { $lt: cutoff } }, { expiresAt: { $exists: false } }, { expiresAt: null }] },
      [{
        $set: {
          expiresAt: {
            $add: [{ $ifNull: ['$createdAt', new Date()] }, RETENTION_DAYS * 86400000],
          },
        },
      }]
    );
    log(`  updated ${res.modifiedCount}`);
  }

  if (!DRY_RUN) {
    await ExtractedLead.createIndexes();
    log('  indexes ensured (direction/intent lookups for the 180-day scan)');
  }

  // ─── Audit after ─────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    section('AFTER');
    log(`total leads                      : ${await ExtractedLead.countDocuments({})}`);
    log(`expiring within 30 days          : ${await ExtractedLead.countDocuments({ expiresAt: { $lt: new Date(Date.now() + 30 * 86400000) } })}`);
    log(`expiring within 180 days         : ${await ExtractedLead.countDocuments({ expiresAt: { $lt: new Date(Date.now() + 180 * 86400000) } })}`);
    const after = await ExtractedLead.aggregate([
      { $group: { _id: '$direction', n: { $sum: 1 } } }, { $sort: { n: -1 } },
    ]);
    log(`by direction                     : ${after.map(d => `${d._id}=${d.n}`).join(', ')}`);
    const dupAfter = await ExtractedLead.aggregate([
      { $match: { source: 'direct_chat' } },
      { $group: { _id: { t: '$originalText', u: '$extractedBy', d: '$direction' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    log(`remaining duplicate groups       : ${dupAfter.length}`);
  }

  await mongoose.connection.close();
  log('\nDone.');
})().catch(async (e) => {
  console.error('\nFatal:', e);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
