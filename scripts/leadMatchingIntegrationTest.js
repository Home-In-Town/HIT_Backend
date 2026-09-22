/**
 * Lead Matching INTEGRATION test — walks complete conversations through the real
 * LeadFlowEngine, feeds the resulting params into the real MatchEngineV2 scoring,
 * and asserts the two halves actually agree with each other.
 *
 * Unit tests pass while integration bugs hide in the SEAMS: values one module
 * emits that the next module doesn't understand. That's what this hunts for.
 *
 * Run: node scripts/leadMatchingIntegrationTest.js
 */

const flow = require('../services/LeadFlowEngine');
const matchEngine = require('../services/MatchEngineV2');
const reverse = require('../services/ReverseMatchService');
const nlp = require('../services/NLPExtractor');
const ptn = require('../services/PropertyTypeNormalizer');
const schema = require('../config/leadSlotSchema');

let pass = 0, fail = 0;
const bugs = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; bugs.push(`${name}${detail ? ` → ${detail}` : ''}`); console.log(`  BUG   ${name}${detail ? ` → ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** Drive a conversation to completion by auto-answering every slot. */
function runConversation(intent, answers = {}) {
  const slots = { intent };
  const asked = [];
  let guard = 0;
  while (guard++ < 40) {
    const next = flow.nextSlot(intent, slots);
    if (!next) break;
    asked.push(next.id);

    if (answers[next.id] !== undefined) { slots[next.id] = answers[next.id]; continue; }

    // Auto-answer with the first valid option / a sane default.
    switch (next.inputType) {
      case 'choice': {
        const opts = flow.resolveOptions(next, slots);
        slots[next.id] = opts.length ? opts[0].value : 'x';
        break;
      }
      case 'multichoice': {
        const opts = flow.resolveOptions(next, slots);
        slots[next.id] = opts.length ? [opts[0].value] : schema.SKIP_VALUE;
        break;
      }
      case 'number':
        slots[next.id] = Array.isArray(next.unit) && next.unit.length
          ? { amount: 100, unit: next.unit[0] } : 100;
        break;
      case 'phone': slots[next.id] = '9876543210'; break;
      default: slots[next.id] = 'Besa';
    }
  }
  return { slots, asked, complete: flow.isComplete(intent, slots) };
}

const project = {
  _id: 'p1', projectName: 'Skyline', city: 'Nagpur', location: 'Besa',
  projectType: 'flat', category: 'Residential', propertyType: 'Apartment / Flat',
  projectStatus: 'ready-to-move', reraApproved: true,
  pricing: { startingPrice: 6000000, bankLoanAvailable: true },
  configuration: { bhkOptions: ['2 BHK', '3 BHK'], carpetAreaRange: '900 - 1200 sqft' },
  owner: { verificationStatus: { builder: 'verified' } },
};

// ─────────────────────────────────────────────────────────────
section('1. Full conversations terminate and complete');

for (const intent of ['buy', 'sell', 'rent']) {
  const r = runConversation(intent);
  check(`${intent}: conversation completes`, r.complete === true, `asked=${r.asked.join('>')}`);
  check(`${intent}: no slot asked twice`, new Set(r.asked).size === r.asked.length, r.asked.join('>'));
  check(`${intent}: contact collected`, !!r.slots.contact, String(r.slots.contact));
}

// Land path must never ask BHK
const land = runConversation('buy', { propertyType: 'Residential Plots' });
check('buy/land: BHK not asked', !land.asked.includes('bhk'), land.asked.join('>'));
check('buy/land: completes', land.complete === true, land.asked.join('>'));

// PG path
const pg = runConversation('buy', { propertyType: 'PG / Co-living Space' });
check('buy/PG: completes', pg.complete === true, pg.asked.join('>'));

// ─────────────────────────────────────────────────────────────
section('2. buildLeadParams output is consumable by MatchEngineV2');

const buy = runConversation('buy', {
  propertyType: 'Flats / Apartments', bhk: '2BHK',
  area: { amount: 1000, unit: 'sqft' }, location: 'Besa', city: 'Nagpur',
  expectedPrice: { amount: 60, unit: 'lakh' }, urgency: 'immediate',
  possession: 'ready',
});
const built = flow.buildLeadParams('buy', buy.slots);
const p = built.params;

check('budget is a number in lakhs', p.budget === 60, String(p.budget));
check('bhkType present', p.bhkType === '2BHK', String(p.bhkType));
check('propertyType normalises to a known family',
  ptn.normalize(p.propertyType).family !== null, `${p.propertyType} → ${JSON.stringify(ptn.normalize(p.propertyType))}`);

const scored = matchEngine._calculateScore(p, project);
check('chat-built params produce a usable score', scored.score >= 25, String(scored.score));
check('budget scored', (scored.breakdown.budget.score || 0) > 0, String(scored.breakdown.budget.score));
check('location scored', (scored.breakdown.location.score || 0) > 0, String(scored.breakdown.location.score));
check('bhk scored', (scored.breakdown.bhk.score || 0) > 0, String(scored.breakdown.bhk.score));
check('propertyType scored', (scored.breakdown.propertyType.score || 0) > 0, String(scored.breakdown.propertyType.score));

// THE SEAM: possession. The chat emits 'ready' / 'under_construction'.
// Does the match engine's possessionMap actually know those keys?
check('possession preference is HONOURED (not silently ignored)',
  scored.breakdown.possession.detail === 'status_match',
  `possessionNeeded='${p.possessionNeeded}' → ${JSON.stringify(scored.breakdown.possession)}`);

// Under-construction requirement against a ready-to-move project must NOT match.
const ucParams = { ...p, possessionNeeded: 'under_construction' };
const ucScore = matchEngine._calculateScore(ucParams, project);
check('under_construction vs ready project → not a status match',
  ucScore.breakdown.possession.detail !== 'status_match',
  JSON.stringify(ucScore.breakdown.possession));

// ─────────────────────────────────────────────────────────────
section('3. Reverse match agrees with forward match');

const rev = reverse._calculateReverseScore(p, project);
check('reverse score is usable', rev.total >= 35, String(rev.total));
check('reverse honours possession too',
  rev.breakdown.possession === 7,
  `possessionNeeded='${p.possessionNeeded}' → ${JSON.stringify(rev.breakdown.possession)}`);
check('reverse counts budget', rev.breakdown.budget > 0, String(rev.breakdown.budget));
check('reverse counts bhk', rev.breakdown.bhk > 0, String(rev.breakdown.bhk));

// ─────────────────────────────────────────────────────────────
section('4. Sell flow → params sanity');

const sell = runConversation('sell', {
  category: 'Residential', propertyTypeDetailed: 'Flats / Apartments', bhk: '3BHK',
  area: { amount: 1500, unit: 'sqft' }, location: 'Besa', city: 'Nagpur',
  expectedPrice: { amount: 1.2, unit: 'cr' }, projectStatus: 'ready-to-move',
});
const sBuilt = flow.buildLeadParams('sell', sell.slots);
check('sell direction', sBuilt.direction === 'sell', sBuilt.direction);
check('cr converted to lakhs (1.2cr = 120L)', sBuilt.params.budget === 120, String(sBuilt.params.budget));
check('sell keeps expectedPrice', sBuilt.params.expectedPrice === 120, String(sBuilt.params.expectedPrice));
check('sell category carried', sBuilt.params.category === 'Residential', String(sBuilt.params.category));
check('sell propertyType uses detailed label',
  sBuilt.params.propertyType === 'Flats / Apartments', String(sBuilt.params.propertyType));
check('sell projectStatus → possessionNeeded mapped',
  !!sBuilt.params.possessionNeeded, String(sBuilt.params.possessionNeeded));

// ─────────────────────────────────────────────────────────────
section('5. Urgency values are storable');

const URGENCY_ENUM = ['normal', 'urgent', 'very_urgent', 'immediate', '1_2_months', 'exploring', 'other'];
for (const opt of flow.getSlot('urgency').options) {
  check(`urgency '${opt.value}' is in the model enum`, URGENCY_ENUM.includes(opt.value), opt.value);
}
// NLP still emits the legacy trio — those must remain valid too.
for (const v of ['normal', 'urgent', 'very_urgent']) {
  check(`legacy urgency '${v}' still valid`, URGENCY_ENUM.includes(v));
}

// ─────────────────────────────────────────────────────────────
section('6. Every category yields usable property types');

for (const cat of flow.getSlot('category').options.map((o) => o.value)) {
  const opts = flow.resolveOptions(flow.getSlot('propertyTypeDetailed'), { category: cat });
  check(`category '${cat}' has detailed types`, opts.length > 0, String(opts.length));
  const real = opts.filter((o) => o.value !== 'Other');
  const allNormalise = real.every((o) => ptn.normalize(o.value).family !== null);
  check(`category '${cat}' types all normalise`, allNormalise,
    real.filter((o) => ptn.normalize(o.value).family === null).map((o) => o.value).join(',') || 'ok');
}

// Buy/rent list must normalise too (drives matching directly).
const unmapped = flow.getSlot('propertyType').options
  .map((o) => o.value)
  .filter((v) => ptn.normalize(v).family === null);
check('all buy/rent property types normalise', unmapped.length === 0, unmapped.join(','));

// ─────────────────────────────────────────────────────────────
section('7. NLP output remains engine-compatible');

const ex = nlp.extract('Client needs 2BHK flat near Besa 60 lakh, ready to move');
check('NLP extraction works', !!ex);
if (ex) {
  const ns = matchEngine._calculateScore(ex.params, project);
  check('NLP params produce a usable score', ns.score >= 25, String(ns.score));
  check('NLP possessionNeeded understood by engine',
    !ex.params.possessionNeeded || ns.breakdown.possession.detail === 'status_match',
    `possessionNeeded='${ex.params.possessionNeeded}' → ${JSON.stringify(ns.breakdown.possession)}`);
}

// ─────────────────────────────────────────────────────────────
section('8. Editing a slot re-branches correctly');

const edited = flow.pruneInapplicable('buy', { ...buy.slots, propertyType: 'Agricultural Land' });
check('switching to land drops bhk', edited.bhk === undefined, JSON.stringify(edited.bhk));
check('switching to land drops possession', edited.possession === undefined, JSON.stringify(edited.possession));
check('land flow still complete after prune', flow.isComplete('buy', edited) === true,
  JSON.stringify(Object.keys(edited)));

console.log(`\n────────────────────────────────`);
console.log(`RESULT: ${pass} passed, ${fail} BUGS FOUND`);
if (bugs.length) { console.log('\nBUGS:'); bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`)); }
