// Temporary verification of the qualify trigger in humanLeadController.
// Deleted after running.
'use strict';

const HumanLead = require('./models/HumanLead');
const hlms = require('./services/HumanLeadMatchService');
const ctrl = require('./controllers/humanLeadController');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Admin caller: canAccess returns true immediately and getPartnerIds short-circuits
// without touching User, so no extra stubs are needed.
const adminUser = { _id: 'A1', role: 'admin', name: 'Admin' };

let matchCalls = [];
hlms.matchQualifiedLead = async (lead, opts) => {
  matchCalls.push({ leadId: String(lead._id), matchSource: opts.matchSource });
  return {
    ran: true, skippedReason: null, missing: [],
    matches: [{ projectId: 'P1', projectName: 'Besa Heights', score: 88 }],
    newCount: 1, total: 1, error: null,
  };
};

function installLead(data) {
  const doc = {
    _id: 'L1',
    createdAt: new Date(),
    stageHistory: [],
    ...data,
    save: async function () { return this; },
    populate() { return this; },
    lean: async function () { return { ...this }; },
  };
  HumanLead.findById = () => doc;
  return doc;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const completeReqs = {
  transactionType: 'buy', budget: 55, city: 'Nagpur',
  locationRaw: 'Besa', propertyType: 'flat', bhkType: '2BHK',
};

(async () => {
  // ── 1. Qualifying an incomplete lead must be refused ──
  console.log('\n=== 1. Cannot qualify a lead with incomplete requirements ===');
  matchCalls = [];
  installLead({ name: 'Incomplete', stage: 'Contacted', requirements: { transactionType: 'buy', city: 'Nagpur' } });
  let res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
  console.log('   status', res.statusCode, '| body', JSON.stringify(res.body));
  ok('returns 400', res.statusCode === 400);
  ok('error code is INCOMPLETE_REQUIREMENTS', res.body.error === 'INCOMPLETE_REQUIREMENTS');
  ok('tells the agent exactly what is missing', Array.isArray(res.body.missing) && res.body.missing.length > 0,
    JSON.stringify(res.body.missing));
  ok('matching was NOT run', matchCalls.length === 0);

  // ── 2. Qualifying a complete lead stamps state and matches ──
  console.log('\n=== 2. Qualifying a complete lead stamps state and runs matching ===');
  matchCalls = [];
  let doc = installLead({ name: 'Good', stage: 'Contacted', requirements: { ...completeReqs } });
  res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
  ok('returns 200', res.statusCode === 200);
  ok('stage moved to Qualified', doc.stage === 'Qualified');
  ok('qualifiedAt stamped', !!doc.qualifiedAt);
  ok('qualifiedBy stamped', doc.qualifiedBy === 'A1');
  ok('matchingEnabled turned on', doc.matchingEnabled === true, 'this is what keeps the lead in the future-match pool');
  ok('stage history recorded', doc.stageHistory.length === 1 && doc.stageHistory[0].to === 'Qualified');
  ok('matching ran once', matchCalls.length === 1, JSON.stringify(matchCalls));
  ok('matchSource is qualification', matchCalls[0] && matchCalls[0].matchSource === 'qualification');
  ok('response carries the real matches', !!res.body.matching && res.body.matching.matches.length === 1,
    JSON.stringify(res.body.matching && res.body.matching.matches));
  ok('response lead is SHAPED (has id, not _id only)', !!res.body.lead && !!res.body.lead.id);

  // ── 3. A non-qualifying stage change must not trigger matching ──
  console.log('\n=== 3. Other stage changes do not trigger matching ===');
  matchCalls = [];
  doc = installLead({ name: 'Good', stage: 'New Lead', requirements: { ...completeReqs } });
  res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Contacted' }, user: adminUser }, res);
  ok('returns 200', res.statusCode === 200);
  ok('matching NOT run for Contacted', matchCalls.length === 0);
  ok('matchingEnabled untouched', !doc.matchingEnabled);
  ok('no matching block in response', res.body.matching === null);

  // ── 4. Re-setting the same stage must not re-qualify or re-match ──
  console.log('\n=== 4. Qualified -> Qualified is idempotent ===');
  matchCalls = [];
  const earlier = new Date('2020-01-01');
  doc = installLead({ name: 'Already', stage: 'Qualified', qualifiedAt: earlier, matchingEnabled: true, requirements: { ...completeReqs } });
  res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
  ok('returns 200', res.statusCode === 200);
  ok('qualifiedAt NOT overwritten', doc.qualifiedAt === earlier);
  ok('matching NOT re-run', matchCalls.length === 0, 'avoids duplicate work on a repeated tap');

  // ── 5. Moving backwards out of Qualified keeps the lead in the pool ──
  console.log('\n=== 5. Moving out of Qualified keeps matchingEnabled ===');
  matchCalls = [];
  doc = installLead({ name: 'Back', stage: 'Qualified', matchingEnabled: true, qualifiedAt: earlier, requirements: { ...completeReqs } });
  res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Negotiation' }, user: adminUser }, res);
  ok('still matchingEnabled', doc.matchingEnabled === true,
    'a lead that progressed past Qualified should keep receiving future matches');

  // ── 6. shape() exposes the new matching fields ──
  console.log('\n=== 6. shape() exposes matching state to the client ===');
  matchCalls = [];
  doc = installLead({ name: 'Shaped', stage: 'Qualified', matchingEnabled: true, matchCount: 3, bestMatchScore: 88, requirements: { ...completeReqs } });
  res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Booking' }, user: adminUser }, res);
  const shaped = res.body.lead;
  for (const k of ['requirements', 'requirementsComplete', 'requirementsMissing', 'requirementsDerivedFrom',
    'qualifiedAt', 'matchingEnabled', 'matchingSkippedReason', 'lastMatchRunAt', 'matchCount', 'bestMatchScore']) {
    ok(`exposes "${k}"`, k in shaped, JSON.stringify(shaped[k]));
  }
  ok('legacy fields still present', 'project' in shaped && 'date' in shaped && 'leadType' in shaped,
    'existing clients must not break');

  // ── 7. Legacy free-text lead can be qualified without re-typing ──
  console.log('\n=== 7. A legacy free-text lead can be qualified ===');
  matchCalls = [];
  doc = installLead({ name: 'Legacy', stage: 'Contacted', budget: '55L', homeType: '2 BHK', location: 'Besa, Nagpur', requirements: {} });
  res = mockRes();
  await ctrl.updateStage({ params: { id: 'L1' }, body: { stage: 'Qualified' }, user: adminUser }, res);
  ok('returns 200 (derived from legacy text)', res.statusCode === 200, JSON.stringify(res.body.error || ''));
  ok('matching ran', matchCalls.length === 1);
  ok('shape reports what was derived', Array.isArray(res.body.lead.requirementsDerivedFrom) && res.body.lead.requirementsDerivedFrom.length > 0,
    JSON.stringify(res.body.lead.requirementsDerivedFrom));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
