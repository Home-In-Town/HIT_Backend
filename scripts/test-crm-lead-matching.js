/**
 * CRM Lead → Property matching — end-to-end behaviour test
 *
 * Covers the flow that turns a manually created, human-qualified CRM lead
 * (HumanLead) into real matched properties:
 *
 *   A. Engine assumptions the design depends on  (pure, no stubs)
 *   B. HumanLeadMatchService contract            (stubbed engine)
 *   C. ReverseMatchService's CRM pass            (stubbed models)
 *   D. The qualify trigger in the controller     (stubbed model)
 *
 * WHY THIS EXISTS
 * Most of what can go wrong here fails SILENTLY rather than throwing:
 *   - a wrong unit produces confidently wrong matches
 *   - `allowNearest` left at its default makes "no match found" unreachable
 *   - adding the CRM pass after an early `return` makes it never run
 *   - a re-publish re-notifying is invisible until users complain
 * So each of those is pinned down with an explicit assertion.
 *
 * No database required — persistence is stubbed. The database-level guarantees
 * (the unique index that prevents duplicate matches) are covered separately by
 * scripts/test-lead-property-match.js, which does need a MongoDB.
 *
 * USAGE
 *   node scripts/test-crm-lead-matching.js
 */

'use strict';

const engine = require('../services/MatchEngineV2');
const mapper = require('../services/LeadRequirementMapper');
const hlms = require('../services/HumanLeadMatchService');
const reverse = require('../services/ReverseMatchService');
const HumanLead = require('../models/HumanLead');
const ExtractedLead = require('../models/ExtractedLead');
const LeadPropertyMatch = require('../models/LeadPropertyMatch');
const ctrl = require('../controllers/humanLeadController');

let passed = 0;
let failed = 0;

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
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected) ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OID = '507f1f77bcf86cd799439011';

const flatProject = {
  _id: OID,
  projectName: 'Besa Heights',
  propertyType: 'Flat',
  category: 'Residential',
  city: 'Nagpur',
  location: 'Besa',
  pricing: { startingPrice: 5500000, bankLoanAvailable: true },
  configuration: { bhkOptions: ['2 BHK', '3 BHK'], carpetAreaRange: '1000-1300' },
  projectStatus: 'ready-to-move',
  reraApproved: true,
  owner: { _id: '507f1f77bcf86cd7994390bb', verificationStatus: { builder: 'verified' } },
};

const plotProject = {
  _id: '507f1f77bcf86cd799439012',
  projectName: 'Green Acres',
  propertyType: 'Plot',
  category: 'Residential',
  city: 'Nagpur',
  location: 'Besa',
  pricing: { startingPrice: 5500000 },
  configuration: { plotSizeRange: '80000 - 90000' },
  projectStatus: 'ready-to-move',
  owner: {},
};

const goodFlatReqs = {
  transactionType: 'buy', budget: 55, city: 'Nagpur', locationRaw: 'Besa',
  propertyType: 'flat', bhkType: '2BHK', area: 1100,
  possessionNeeded: 'ready', loanRequired: true,
};

// ─── A. Engine assumptions the design depends on ─────────────────────────────

section('A. Engine assumptions (pure scoring, no stubs)');

{
  const good = mapper.toRequirement({ requirements: goodFlatReqs });
  const res = engine._calculateScore(good, flatProject);
  ok('a well-specified lead clears the 45 bar', res.score >= 45, `score ${res.score}`);
  ok('and is graded as a real match', res.score >= 70, `matchQuality would be "exact" at ${res.score}`);
}

{
  // THE assumption behind allowNearest:false and isMatchable's required fields.
  const empty = mapper.toRequirement({ requirements: {} });
  const res = engine._calculateScore(empty, flatProject);
  ok('a lead specifying NOTHING still scores above zero', res.score > 0,
    `score ${res.score} from neutral/free credit (type ${res.breakdown.propertyType.score} + loan ${res.breakdown.loan.score} + possession ${res.breakdown.possession.score} + verified ${(res.breakdown.verified || {}).score || 0} + rera ${(res.breakdown.rera || {}).score || 0})`);
  ok('...but stays well below the 45 match bar', res.score < 45, `score ${res.score}`);
  console.log('        ↳ this is why allowNearest MUST be false: with the engine default,');
  console.log('          these free points are returned as a "nearest" match and');
  console.log('          "no matching property" becomes unreachable.');
}

{
  const wrongCity = mapper.toRequirement({
    requirements: { transactionType: 'buy', budget: 500, city: 'Mumbai', locationRaw: 'Andheri', propertyType: 'plot', area: 5000 },
  });
  const res = engine._calculateScore(wrongCity, flatProject);
  ok('a wrong-city, wrong-type, wrong-budget lead stays under 45', res.score < 45, `score ${res.score}`);
}

{
  const base = mapper.toRequirement({ requirements: { budget: 55, city: 'Nagpur', locationRaw: 'Besa', propertyType: 'plot' } });
  const raw = engine._calculateScore({ ...base, area: 2 }, plotProject).breakdown.area;
  const converted = engine._calculateScore({ ...base, area: mapper.toSqft(2, 'acres') }, plotProject).breakdown.area;
  ok('acres→sqft conversion materially changes the match', converted.score > raw.score,
    `area=2 scores ${raw.score}, area=${mapper.toSqft(2, 'acres')} scores ${converted.score}`);
}

{
  const plotReq = mapper.toRequirement({
    requirements: { budget: 55, city: 'Nagpur', locationRaw: 'Besa', propertyType: 'plot', area: 87120 },
  });
  const res = engine._calculateScore(plotReq, plotProject);
  ok('BHK scoring is skipped for land types', res.breakdown.bhk.skipped === true,
    'which is why isMatchable requires area (not BHK) for land');
}

// ─── B. HumanLeadMatchService contract ───────────────────────────────────────

section('B. HumanLeadMatchService — engine options and gating');

const realFindMatches = engine.findMatches;
const realRecordMatch = LeadPropertyMatch.recordMatch;
const realAggregate = LeadPropertyMatch.aggregate;
const realUpdateOne = HumanLead.updateOne;

(async () => {
  // ── B1: the critical options actually reach the engine ──
  {
    let captured = null;
    const recorded = [];
    engine.findMatches = async (req, opts) => {
      captured = { req, opts };
      return [
        { project: { ...flatProject }, score: 88, confidence: 0.9, matchedOn: ['budget', 'bhk'], matchQuality: 'exact' },
        { project: { ...plotProject }, score: 52, confidence: 0.6, matchedOn: ['budget'], matchQuality: 'close' },
        // The engine should never hand this back with allowNearest:false, but if
        // it did, the service must drop it.
        { project: { _id: 'x1', projectName: 'Weak' }, score: 20, matchedOn: [], matchQuality: 'nearest', nearest: true },
      ];
    };
    LeadPropertyMatch.recordMatch = async (a) => { recorded.push(a); return { isNew: true, previous: null }; };
    LeadPropertyMatch.aggregate = async () => [{ matchCount: recorded.length, bestMatchScore: 88 }];
    HumanLead.updateOne = async () => ({ acknowledged: true });

    const res = await hlms.matchQualifiedLead(
      { _id: '507f1f77bcf86cd799439099', requirements: goodFlatReqs },
      { matchSource: 'qualification' },
    );

    ok('allowNearest is explicitly FALSE', captured.opts.allowNearest === false,
      `opts=${JSON.stringify(captured.opts)}`);
    eq('minScore is the CRM bar (45)', captured.opts.minScore, 45);
    ok('no owner is excluded (an agent may match their own stock)', captured.opts.excludeOwner === undefined);
    ok('budget reaches the engine as a NUMBER in lakhs', typeof captured.req.budget === 'number' && captured.req.budget === 55);
    ok('locality and city arrive as separate fields',
      captured.req.locationRaw === 'Besa' && captured.req.city === 'Nagpur');

    eq('only the two solid matches are persisted', recorded.length, 2);
    ok('a nearest-flagged result is dropped even if returned', !recorded.some(r => r.score < 45),
      `scores: ${recorded.map(r => r.score).join(',')}`);
    ok('matchQuality is normalised into the schema enum',
      recorded.every(r => ['exact', 'close'].includes(r.matchQuality)),
      recorded.map(r => r.matchQuality).join(','));
    eq('matchSource is recorded for audit', recorded[0].matchSource, 'qualification');
    ok('result reports what the caller needs', res.ran === true && res.matches.length === 2 && res.newCount === 2,
      `ran=${res.ran} matches=${res.matches.length} new=${res.newCount}`);
    ok('cards carry the stable project id', res.matches[0].projectId === OID, res.matches[0].projectId);
  }

  // ── B2: a genuine "nothing matched" is reported as such ──
  {
    engine.findMatches = async () => [];
    HumanLead.updateOne = async () => ({ acknowledged: true });
    LeadPropertyMatch.aggregate = async () => [];

    const res = await hlms.matchQualifiedLead({ _id: '507f1f77bcf86cd799439098', requirements: goodFlatReqs });
    ok('matching ran but found nothing', res.ran === true && res.matches.length === 0);
    eq('no skip reason is set for a real empty result', res.skippedReason, null);
    console.log('        ↳ the lead keeps matchingEnabled, so a later publish picks it up');
  }

  // ── B3: gates ──
  {
    const rent = await hlms.matchQualifiedLead(
      { _id: OID, requirements: { transactionType: 'rent', rentBudgetMonthly: 25000, city: 'Nagpur', propertyType: 'flat', bhkType: '2BHK' } },
      { persistSkipReason: false },
    );
    ok('rent leads are skipped, not matched against sale prices',
      rent.ran === false && rent.skippedReason === 'rent_not_supported');

    const incomplete = await hlms.matchQualifiedLead(
      { _id: OID, requirements: { transactionType: 'buy', city: 'Nagpur' } },
      { persistSkipReason: false },
    );
    ok('incomplete leads are skipped with the missing list',
      incomplete.ran === false && incomplete.skippedReason === 'incomplete_requirements' && incomplete.missing.length > 0,
      JSON.stringify(incomplete.missing));

    const emptyLead = await hlms.matchQualifiedLead({ _id: OID, requirements: {} }, { persistSkipReason: false });
    ok('the "scores from nothing" lead never reaches the engine', emptyLead.ran === false,
      `missing: ${emptyLead.missing.sort().join(',')}`);

    const bad = await hlms.matchQualifiedLead('not-an-objectid', { persistSkipReason: false });
    eq('an invalid id is handled, not thrown', bad.error, 'lead_not_found');

    let threw = false;
    try { await hlms.matchQualifiedLead(null, { persistSkipReason: false }); } catch { threw = true; }
    ok('the service never throws (a stage change must not fail because of matching)', !threw);
  }

  engine.findMatches = realFindMatches;

  // ─── C. ReverseMatchService's CRM pass ────────────────────────────────────

  section('C. ReverseMatchService — qualified CRM leads are re-scored on publish');

  const realExtractedFind = ExtractedLead.find;
  const realHumanFind = HumanLead.find;
  const realRecordMatches = hlms.recordMatches;
  const realRefresh = hlms.refreshLeadMatchSummary;

  {
    // Force the chat-lead pass to exit early. The CRM pass must still run — this
    // is the regression the two-pass split exists to prevent.
    ExtractedLead.find = () => ({
      populate() { return this; }, sort() { return this; }, limit() { return this; },
      lean: async () => [],
    });

    let capturedFilter = null;
    const leads = [
      { _id: 'L1', name: 'Strong', requirements: goodFlatReqs },
      { _id: 'L2', name: 'WrongCity', requirements: { transactionType: 'buy', budget: 500, city: 'Mumbai', locationRaw: 'Andheri', propertyType: 'flat', bhkType: '4BHK' } },
      // Scores above the bar so it genuinely reaches recordMatches and throws.
      { _id: 'L3', name: 'Exploder', requirements: goodFlatReqs },
      // Ordered after the thrower to prove the loop continues.
      { _id: 'L4', name: 'AfterThrow', requirements: { ...goodFlatReqs, bhkType: '3BHK' } },
    ];
    HumanLead.find = (f) => {
      capturedFilter = f;
      return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => leads };
    };

    const calls = [];
    hlms.recordMatches = async (leadId, matches, src) => {
      if (String(leadId) === 'L3') throw new Error('simulated failure');
      calls.push({ leadId: String(leadId), score: matches[0].score, src });
      return { newPairs: [{ projectId: flatProject._id, score: matches[0].score }], existing: 0 };
    };
    hlms.refreshLeadMatchSummary = async () => ({ matchCount: 1, bestMatchScore: 100 });

    await reverse.onProjectPublished(flatProject, null);

    ok('the CRM pass runs even when the chat pass exits early', capturedFilter !== null);
    ok('only leads an agent qualified are considered', capturedFilter.matchingEnabled === true);
    ok('archived leads are excluded', capturedFilter.archived === false);
    ok('rent leads are excluded at the query level',
      capturedFilter['requirements.transactionType'] && capturedFilter['requirements.transactionType'].$ne === 'rent');
    ok('a recency window is applied', !!capturedFilter.updatedAt && !!capturedFilter.updatedAt.$gte);
    ok('the city arm still admits leads with no city recorded', Array.isArray(capturedFilter.$or));

    const ids = calls.map(c => c.leadId);
    ok('a mismatched lead is rejected by score', !ids.includes('L2'));
    ok('nothing below the 45 CRM bar is recorded', calls.every(c => c.score >= 45),
      `scores: ${calls.map(c => c.score).join(',')}`);
    eq('matches from a publish are tagged as such', calls[0].src, 'project_published');
    ok('a lead that throws is skipped, not fatal', !ids.includes('L3'));
    ok('processing CONTINUES past the failure', ids.includes('L4'),
      `recorded: ${ids.join(',')}`);
  }

  ExtractedLead.find = realExtractedFind;
  HumanLead.find = realHumanFind;
  hlms.recordMatches = realRecordMatches;
  hlms.refreshLeadMatchSummary = realRefresh;

  // ─── D. The qualify trigger ───────────────────────────────────────────────

  section('D. Qualify trigger — validation, stamping and matching');

  const realFindById = HumanLead.findById;
  const realMatchQualified = hlms.matchQualifiedLead;

  const adminUser = { _id: 'A1', role: 'admin', name: 'Admin' };
  let matchRuns = [];
  hlms.matchQualifiedLead = async (lead, opts) => {
    matchRuns.push({ leadId: String(lead._id), matchSource: opts.matchSource });
    return {
      ran: true, skippedReason: null, missing: [],
      matches: [{ projectId: OID, projectName: 'Besa Heights', score: 88 }],
      newCount: 1, total: 1, error: null,
    };
  };

  function installLead(data) {
    const doc = {
      _id: 'L1', createdAt: new Date(), stageHistory: [], ...data,
      save: async function () { return this; },
      populate() { return this; },
      lean: async function () { return { ...this }; },
    };
    HumanLead.findById = () => doc;
    return doc;
  }

  const mockRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });

  {
    matchRuns = [];
    installLead({ name: 'Incomplete', stage: 'Contacted', requirements: { transactionType: 'buy', city: 'Nagpur' } });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
    eq('qualifying an incomplete lead is rejected with 400', res.statusCode, 400);
    eq('with a machine-readable code', res.body.error, 'INCOMPLETE_REQUIREMENTS');
    ok('and the exact missing fields', Array.isArray(res.body.missing) && res.body.missing.length > 0,
      JSON.stringify(res.body.missing));
    eq('matching did not run', matchRuns.length, 0);
  }

  {
    matchRuns = [];
    const doc = installLead({ name: 'Good', stage: 'Contacted', requirements: { ...goodFlatReqs } });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
    eq('qualifying a complete lead succeeds', res.statusCode, 200);
    ok('qualifiedAt / qualifiedBy are stamped', !!doc.qualifiedAt && doc.qualifiedBy === 'A1');
    ok('matchingEnabled is turned on', doc.matchingEnabled === true,
      'this is what keeps the lead in the future-match pool');
    ok('the stage change is recorded in history',
      doc.stageHistory.length === 1 && doc.stageHistory[0].to === 'Qualified');
    eq('matching ran exactly once', matchRuns.length, 1);
    eq('tagged as a qualification', matchRuns[0].matchSource, 'qualification');
    ok('the response carries the real matched properties',
      !!res.body.matching && res.body.matching.matches.length === 1);
    ok('the response lead is shaped for the client', !!res.body.lead && !!res.body.lead.id);
  }

  {
    matchRuns = [];
    const doc = installLead({ name: 'Other', stage: 'New Lead', requirements: { ...goodFlatReqs } });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Contacted' }, user: adminUser }, res);
    eq('a non-qualifying stage change does not match', matchRuns.length, 0);
    ok('and does not enable matching', !doc.matchingEnabled);
    eq('and carries no matching block', res.body.matching, null);
  }

  {
    matchRuns = [];
    const earlier = new Date('2020-01-01');
    const doc = installLead({ name: 'Already', stage: 'Qualified', qualifiedAt: earlier, matchingEnabled: true, requirements: { ...goodFlatReqs } });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
    ok('Qualified → Qualified does not re-stamp', doc.qualifiedAt === earlier);
    eq('and does not re-run matching', matchRuns.length, 0);
  }

  {
    matchRuns = [];
    const doc = installLead({ name: 'Progressed', stage: 'Qualified', matchingEnabled: true, qualifiedAt: new Date(), requirements: { ...goodFlatReqs } });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Negotiation' }, user: adminUser }, res);
    ok('moving PAST Qualified keeps the lead in the match pool', doc.matchingEnabled === true,
      'a lead in Negotiation should still hear about new inventory');
  }

  {
    matchRuns = [];
    installLead({ name: 'Shaped', stage: 'Qualified', matchingEnabled: true, matchCount: 3, bestMatchScore: 88, requirements: { ...goodFlatReqs } });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Booking' }, user: adminUser }, res);
    const shaped = res.body.lead;
    const expected = ['requirements', 'requirementsComplete', 'requirementsMissing', 'requirementsDerivedFrom',
      'qualifiedAt', 'matchingEnabled', 'matchingSkippedReason', 'lastMatchRunAt', 'matchCount', 'bestMatchScore'];
    ok('the client sees all matching state', expected.every(k => k in shaped),
      expected.filter(k => !(k in shaped)).join(',') || 'all present');
    ok('legacy fields are untouched', 'project' in shaped && 'date' in shaped && 'leadType' in shaped,
      'existing clients must not break');
  }

  {
    // A lead created before structured requirements existed must still be usable.
    matchRuns = [];
    installLead({ name: 'Legacy', stage: 'Contacted', budget: '55L', homeType: '2 BHK', location: 'Besa, Nagpur', requirements: {} });
    const res = mockRes();
    await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
    eq('a legacy free-text lead can be qualified without re-typing', res.statusCode, 200);
    eq('and matching runs for it', matchRuns.length, 1);
    ok('while reporting which values were inferred',
      Array.isArray(res.body.lead.requirementsDerivedFrom) && res.body.lead.requirementsDerivedFrom.length > 0,
      JSON.stringify(res.body.lead.requirementsDerivedFrom));
  }

  HumanLead.findById = realFindById;
  hlms.matchQualifiedLead = realMatchQualified;
  LeadPropertyMatch.recordMatch = realRecordMatch;
  LeadPropertyMatch.aggregate = realAggregate;
  HumanLead.updateOne = realUpdateOne;

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(72));
  if (failed === 0) {
    console.log('\nNote: the database-level duplicate-match guarantee is covered by');
    console.log('scripts/test-lead-property-match.js (requires a MongoDB).\n');
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\nTest run crashed:', err.message, '\n', err.stack);
  process.exit(1);
});
