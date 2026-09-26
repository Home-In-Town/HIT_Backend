/**
 * LeadPropertyMatch — dedupe / idempotency test
 *
 * Verifies the guarantees the CRM property-matching flow depends on:
 *   1. a brand-new (lead, project) pair is reported as new  → callers notify
 *   2. re-recording the same pair is reported as NOT new     → callers stay silent
 *      (this is what prevents duplicate matches AND duplicate notifications
 *       when a project is edited or re-published)
 *   3. only ONE row ever exists per pair, enforced by the unique index
 *   4. re-scoring refreshes `score` but never moves `firstMatchedAt`
 *   5. a raw duplicate insert is rejected by the database (code 11000)
 *   6. markNotified is idempotent per user
 *   7. leadModel is part of the identity, so HumanLead and ExtractedLead with
 *      coincidentally equal ids are distinct pairs
 *
 * These cannot be checked with validateSync — they are index and upsert
 * behaviours, so a real MongoDB is required.
 *
 * USAGE
 *   node scripts/test-lead-property-match.js
 *   TEST_MONGO_URI=mongodb://127.0.0.1:27017/hit_devtest node scripts/test-lead-property-match.js
 *
 * SAFETY
 *   This script calls dropDatabase(). It therefore REFUSES to run unless the
 *   target database name contains "test". It deliberately does not read
 *   MONGO_URI, so it can never point at the application database by accident.
 */

const mongoose = require('mongoose');

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/hit_leadmatch_devtest';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertSafeTarget(uri) {
  // Strip credentials before any logging, then isolate the database name.
  const dbName = (uri.split('/').pop() || '').split('?')[0];
  if (!/test/i.test(dbName)) {
    console.error(
      `\nRefusing to run: target database "${dbName}" does not contain "test".\n` +
      'This script drops the database it connects to. Point TEST_MONGO_URI at a\n' +
      'throwaway database whose name contains "test".\n'
    );
    process.exit(2);
  }
  return dbName;
}

async function main() {
  const dbName = assertSafeTarget(URI);
  console.log(`\nLeadPropertyMatch dedupe test — database: ${dbName}\n`);

  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000 });
  } catch (err) {
    console.log(`SKIP: could not reach MongoDB (${err.message.split('\n')[0]})`);
    console.log('Start a local mongod or set TEST_MONGO_URI, then re-run.\n');
    process.exit(3);
  }

  const LeadPropertyMatch = require('../models/LeadPropertyMatch');

  // Clean slate, and make sure the unique index actually exists on the
  // collection (a declared index is not an enforced index until it is built).
  await LeadPropertyMatch.collection.drop().catch(() => {});
  await LeadPropertyMatch.syncIndexes();

  const builtIndexes = await LeadPropertyMatch.collection.indexes();
  const uniquePair = builtIndexes.find(
    (i) => i.unique && i.key.leadModel === 1 && i.key.lead === 1 && i.key.project === 1
  );
  check('unique (leadModel, lead, project) index is built', !!uniquePair, uniquePair?.name);

  const oid = () => new mongoose.Types.ObjectId();
  const lead = oid();
  const project = oid();
  const agent = oid();

  // 1 — first record is new
  const first = await LeadPropertyMatch.recordMatch({
    lead, leadModel: 'HumanLead', project,
    score: 70, confidence: 0.7, matchedOn: ['budget'], matchQuality: 'close',
    matchSource: 'qualification',
  });
  check('first record for a pair is reported new', first.isNew === true);

  const afterFirst = await LeadPropertyMatch.findOne({ lead, project }).lean();
  const originalFirstMatchedAt = afterFirst.firstMatchedAt;

  // Make the timestamps distinguishable.
  await new Promise((r) => setTimeout(r, 15));

  // 2 — same pair again is NOT new (the dedupe guarantee)
  const second = await LeadPropertyMatch.recordMatch({
    lead, leadModel: 'HumanLead', project,
    score: 82, confidence: 0.85, matchedOn: ['budget', 'bhk'], matchQuality: 'exact',
    matchSource: 'project_published',
  });
  check('re-recording the same pair is reported NOT new', second.isNew === false);

  // 3 — still exactly one row
  const rows = await LeadPropertyMatch.countDocuments({ lead, project });
  check('exactly one row exists per pair', rows === 1, `found ${rows}`);

  // 4 — score refreshed, firstMatchedAt preserved
  const afterSecond = await LeadPropertyMatch.findOne({ lead, project }).lean();
  check('score is refreshed on re-record', afterSecond.score === 82, `score=${afterSecond.score}`);
  check('matchedOn is refreshed on re-record', afterSecond.matchedOn.join(',') === 'budget,bhk');
  check(
    'firstMatchedAt is NOT moved by re-scoring',
    afterSecond.firstMatchedAt.getTime() === originalFirstMatchedAt.getTime()
  );
  check(
    'lastScoredAt advances past firstMatchedAt',
    afterSecond.lastScoredAt.getTime() > afterSecond.firstMatchedAt.getTime()
  );

  // 5 — raw duplicate insert blocked by the database
  let duplicateBlocked = false;
  let dupErrCode;
  try {
    await LeadPropertyMatch.create({ lead, leadModel: 'HumanLead', project, score: 10 });
  } catch (err) {
    dupErrCode = err.code;
    duplicateBlocked = err.code === 11000;
  }
  check('raw duplicate insert is rejected by the unique index', duplicateBlocked, `code=${dupErrCode}`);

  // 6 — markNotified idempotency
  const notifiedOnce = await LeadPropertyMatch.markNotified(afterSecond._id, agent);
  const notifiedTwice = await LeadPropertyMatch.markNotified(afterSecond._id, agent);
  check('markNotified returns true the first time', notifiedOnce === true);
  check('markNotified returns false the second time', notifiedTwice === false);
  const notifiedDoc = await LeadPropertyMatch.findById(afterSecond._id).lean();
  check('notifiedUsers has no duplicates', notifiedDoc.notifiedUsers.length === 1,
    `length=${notifiedDoc.notifiedUsers.length}`);

  // 7 — leadModel participates in identity
  const crossModel = await LeadPropertyMatch.recordMatch({
    lead, leadModel: 'ExtractedLead', project, score: 60,
  });
  check('same ids under a different leadModel is a separate pair', crossModel.isNew === true);
  const totalForIds = await LeadPropertyMatch.countDocuments({ lead, project });
  check('both leadModel rows coexist', totalForIds === 2, `found ${totalForIds}`);

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nTest run crashed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
