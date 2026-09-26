/**
 * LeadRequirementMapper — unit tests
 *
 * This mapper is the boundary where a human-typed CRM lead becomes something
 * MatchEngineV2 can score. Every bug here is silent: a wrong unit does not
 * throw, it just produces confidently wrong matches (a 2-acre plot scored as
 * 2 sqft, a ₹25,000/month rent read as ₹250 crore). So the conversions are
 * pinned down here.
 *
 * No database required.
 *
 * USAGE
 *   node scripts/test-lead-requirement-mapper.js
 */

'use strict';

const mapper = require('../services/LeadRequirementMapper');
const { SQFT_PER_ACRE } = require('../services/LeadRequirementMapper');

let passed = 0;
let failed = 0;
let group = '';

function section(name) {
  group = name;
  console.log(`\n${name}`);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  }
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

// ─── Budget (sale) — must come out in LAKHS ──────────────────────────────────
section('parseBudget — result is always LAKHS');

const budgetCases = [
  [50, { budget: 50, budgetMax: null }, 'bare number'],
  ['50', { budget: 50, budgetMax: null }, 'numeric string'],
  ['50L', { budget: 50, budgetMax: null }, 'L suffix'],
  ['50 lakh', { budget: 50, budgetMax: null }, 'lakh spelled out'],
  ['50 lac', { budget: 50, budgetMax: null }, 'lac spelling'],
  ['1.2Cr', { budget: 120, budgetMax: null }, 'crore → lakhs'],
  ['1.2 crore', { budget: 120, budgetMax: null }, 'crore spelled out'],
  ['\u20b91,20,00,000', { budget: 120, budgetMax: null }, 'rupees with symbol + commas'],
  ['5000000', { budget: 50, budgetMax: null }, 'bare rupees'],
  ['50-60L', { budget: 50, budgetMax: 60 }, 'range, unit on second side only'],
  ['80L - 1.2Cr', { budget: 80, budgetMax: 120 }, 'range with MIXED units'],
  ['1 to 1.5 cr', { budget: 100, budgetMax: 150 }, '"to" range'],
  ['60-50L', { budget: 50, budgetMax: 60 }, 'reversed range is tolerated'],
  ['', { budget: null, budgetMax: null }, 'empty string'],
  ['abc', { budget: null, budgetMax: null }, 'no digits'],
  [null, { budget: null, budgetMax: null }, 'null'],
  [undefined, { budget: null, budgetMax: null }, 'undefined'],
  [0, { budget: null, budgetMax: null }, 'zero rejected'],
  [-5, { budget: null, budgetMax: null }, 'negative rejected'],
];
for (const [input, expected, label] of budgetCases) {
  eq(`${label}: ${JSON.stringify(input)}`, mapper.parseBudget(input), expected);
}

// ─── Rent — must come out in RUPEES PER MONTH ────────────────────────────────
section('parseMonthlyRent — result is always RUPEES/MONTH');

const rentCases = [
  ['25000', 25000, 'plain rupees'],
  [25000, 25000, 'number'],
  ['25k', 25000, 'k shorthand'],
  ['\u20b925,000', 25000, 'symbol + comma'],
  ['25000/mo', 25000, 'with /mo suffix'],
  ['1.5 lakh', 150000, 'lakh rent — must NOT be read as 1500'],
  ['', null, 'empty'],
  [null, null, 'null'],
  [0, null, 'zero rejected'],
];
for (const [input, expected, label] of rentCases) {
  eq(`${label}: ${JSON.stringify(input)}`, mapper.parseMonthlyRent(input), expected);
}

// The specific confusion this split exists to prevent.
ok(
  'a rent figure is NOT run through the lakhs parser',
  mapper.parseMonthlyRent('25000') === 25000 && mapper.parseBudget('25000').budget === 25000,
  'same input, different quantity — which is why they are separate fields'
);

// ─── Area — must come out in SQFT ────────────────────────────────────────────
section('toSqft — result is always SQFT');

eq('sqft passes through', mapper.toSqft(1100, 'sqft'), 1100);
eq('acres are converted', mapper.toSqft(2, 'acres'), 2 * SQFT_PER_ACRE);
eq('fractional acres', mapper.toSqft(0.5, 'acres'), Math.round(0.5 * SQFT_PER_ACRE));
eq('missing unit defaults to sqft', mapper.toSqft(900), 900);
eq('zero rejected', mapper.toSqft(0, 'sqft'), null);
eq('non-numeric rejected', mapper.toSqft('abc', 'sqft'), null);
ok('2 acres is 87120 sqft, not 2', mapper.toSqft(2, 'acres') === 87120);

// ─── Home type ──────────────────────────────────────────────────────────────
section('parseHomeType — splits BHK from property type');

const homeTypeCases = [
  ['1 BHK', { bhkType: '1BHK', propertyType: 'flat' }],
  ['2 BHK', { bhkType: '2BHK', propertyType: 'flat' }],
  ['5 BHK+', { bhkType: '5BHK', propertyType: 'flat' }],
  ['3 BHK Villa', { bhkType: '3BHK', propertyType: 'villa' }],
  ['Villa', { bhkType: null, propertyType: 'villa' }],
  ['Plot', { bhkType: null, propertyType: 'plot' }],
  ['Farm Land', { bhkType: null, propertyType: 'farm_land' }],
  ['Office', { bhkType: null, propertyType: 'office' }],
  ['', { bhkType: null, propertyType: null }],
  [null, { bhkType: null, propertyType: null }],
];
for (const [input, expected] of homeTypeCases) {
  eq(`${JSON.stringify(input)}`, mapper.parseHomeType(input), expected);
}
ok(
  'a bare BHK count implies a flat',
  mapper.parseHomeType('2 BHK').propertyType === 'flat',
  'leaving type null would let flats and plots rank against each other'
);

// ─── Location ───────────────────────────────────────────────────────────────
section('splitLocation — locality and city are separate');

eq('locality, city', mapper.splitLocation('Besa, Nagpur'), { locationRaw: 'Besa', city: 'Nagpur' });
eq('multi-part locality', mapper.splitLocation('Sector 5, Besa, Nagpur'), { locationRaw: 'Sector 5, Besa', city: 'Nagpur' });
eq('single token is a CITY, not a locality', mapper.splitLocation('Nagpur'), { locationRaw: null, city: 'Nagpur' });
eq('empty', mapper.splitLocation(''), { locationRaw: null, city: null });
ok(
  'a single token does not invent a locality',
  mapper.splitLocation('Nagpur').locationRaw === null,
  'claiming a locality triggers the reverse-match location penalty on every project in the city'
);

// ─── normalizeRequirements (write path) ─────────────────────────────────────
section('normalizeRequirements — server-side normalisation on write');

const buyIn = mapper.normalizeRequirements({
  transactionType: 'buy',
  budget: '50-60L',
  bhkType: '2 bhk',
  propertyType: 'Flats / Apartments',
  area: 2,
  areaUnit: 'acres',
  locationRaw: 'Besa',
  city: 'Nagpur',
  possessionNeeded: 'ready',
  loanRequired: true,
});
eq('buy: budget parsed to lakhs', [buyIn.budget, buyIn.budgetMax], [50, 60]);
eq('buy: bhk canonicalised', buyIn.bhkType, '2BHK');
eq('buy: rich type label normalised', buyIn.propertyType, 'flat');
eq('buy: area stored as sqft', buyIn.area, 2 * SQFT_PER_ACRE);
eq('buy: original area value preserved', [buyIn.areaInput, buyIn.areaUnit], [2, 'acres']);
ok('buy: rentBudgetMonthly not set', buyIn.rentBudgetMonthly === undefined);
ok('buy: locationCanonical derived', 'locationCanonical' in buyIn, String(buyIn.locationCanonical));

const rentIn = mapper.normalizeRequirements({
  transactionType: 'rent',
  budget: '25000',
  bhkType: '2BHK',
  propertyType: 'flat',
  city: 'Nagpur',
});
eq('rent: monthly rupees captured', rentIn.rentBudgetMonthly, 25000);
ok('rent: lakhs budget left unset', rentIn.budget === undefined && rentIn.budgetMax === undefined,
  'this is the ₹25k/month → ₹250Cr bug being prevented');

const explicitMax = mapper.normalizeRequirements({ budget: '50L', budgetMax: '75L' });
eq('explicit budgetMax wins', [explicitMax.budget, explicitMax.budgetMax], [50, 75]);

// ─── resolve (read path, legacy fallback) ───────────────────────────────────
section('resolve — legacy free-text leads stay matchable');

const legacyLead = {
  budget: '55L',
  homeType: '2 BHK',
  location: 'Besa, Nagpur',
  requirements: {},
};
const resolvedLegacy = mapper.resolve(legacyLead);
eq('legacy budget derived', resolvedLegacy.effective.budget, 55);
eq('legacy bhk derived', resolvedLegacy.effective.bhkType, '2BHK');
eq('legacy type derived', resolvedLegacy.effective.propertyType, 'flat');
eq('legacy city derived', resolvedLegacy.effective.city, 'Nagpur');
eq('legacy locality derived', resolvedLegacy.effective.locationRaw, 'Besa');
ok('derivation is reported, not silent',
  ['budget', 'bhkType', 'propertyType', 'city', 'locationRaw'].every((k) => resolvedLegacy.derivedFrom.includes(k)),
  resolvedLegacy.derivedFrom.join(','));

const structuredWins = mapper.resolve({
  budget: '10L',
  homeType: '1 BHK',
  requirements: { budget: 90, bhkType: '3BHK', propertyType: 'villa', city: 'Pune' },
});
eq('structured values override legacy', 
  [structuredWins.effective.budget, structuredWins.effective.bhkType, structuredWins.effective.propertyType],
  [90, '3BHK', 'villa']);
ok('nothing marked derived when structured is present',
  !structuredWins.derivedFrom.includes('budget') && !structuredWins.derivedFrom.includes('bhkType'));

const legacyRent = mapper.resolve({
  budget: '25000',
  requirements: { transactionType: 'rent' },
});
eq('legacy rent goes to rentBudgetMonthly', legacyRent.effective.rentBudgetMonthly, 25000);
eq('legacy rent does NOT populate lakhs budget', legacyRent.effective.budget, null);

// ─── toRequirement (engine contract) ───────────────────────────────────────
section('toRequirement — matches the MatchEngineV2 field contract');

const req = mapper.toRequirement({
  requirements: {
    transactionType: 'buy',
    budget: 55, budgetMax: 65,
    bhkType: '2BHK', propertyType: 'flat',
    area: 1100, areaUnit: 'sqft', areaInput: 1100,
    locationRaw: 'Besa', city: 'Nagpur',
    possessionNeeded: 'ready', loanRequired: true,
  },
});
// These are the exact keys MatchEngineV2 reads off a requirement.
for (const key of ['budget', 'budgetMax', 'locationRaw', 'location', 'city', 'bhkType',
  'propertyType', 'area', 'loanRequired', 'possessionNeeded']) {
  ok(`exposes "${key}"`, key in req, JSON.stringify(req[key]));
}
eq('areaUnit is declared sqft (engine assumes sqft)', req.areaUnit, 'sqft');
ok('budget is a number, not a string', typeof req.budget === 'number');
ok('area is a number, not a string', typeof req.area === 'number');

// ─── isMatchable ───────────────────────────────────────────────────────────
section('isMatchable — gates qualification on data the engine actually needs');

const completeFlat = { requirements: { transactionType: 'buy', budget: 55, city: 'Nagpur', propertyType: 'flat', bhkType: '2BHK' } };
eq('complete flat lead is matchable', mapper.isMatchable(completeFlat).missing, []);
ok('complete flat lead ok', mapper.isMatchable(completeFlat).ok === true);

eq('missing budget is reported',
  mapper.isMatchable({ requirements: { city: 'Nagpur', propertyType: 'flat', bhkType: '2BHK' } }).missing,
  ['budget']);

eq('missing city is reported',
  mapper.isMatchable({ requirements: { budget: 55, propertyType: 'flat', bhkType: '2BHK' } }).missing,
  ['city']);

eq('flat without BHK is reported',
  mapper.isMatchable({ requirements: { budget: 55, city: 'Nagpur', propertyType: 'flat' } }).missing,
  ['bhkType']);

eq('plot without area is reported',
  mapper.isMatchable({ requirements: { budget: 55, city: 'Nagpur', propertyType: 'plot' } }).missing,
  ['area']);

ok('plot does NOT require BHK',
  !mapper.isMatchable({ requirements: { budget: 55, city: 'Nagpur', propertyType: 'plot', area: 2000 } }).missing.includes('bhkType'),
  'the engine skips BHK scoring for land types');

eq('plot with area is matchable',
  mapper.isMatchable({ requirements: { budget: 55, city: 'Nagpur', propertyType: 'plot', area: 2000 } }).missing,
  []);

eq('empty lead reports everything missing',
  mapper.isMatchable({ requirements: {} }).missing.sort(),
  ['budget', 'city', 'propertyType']);

const rentComplete = { requirements: { transactionType: 'rent', rentBudgetMonthly: 25000, city: 'Nagpur', propertyType: 'flat', bhkType: '2BHK' } };
ok('rent lead can be qualified via rentBudgetMonthly', mapper.isMatchable(rentComplete).ok === true,
  'an agent must not be blocked from qualifying a rent lead');
eq('rent lead missing its rent is reported',
  mapper.isMatchable({ requirements: { transactionType: 'rent', city: 'Nagpur', propertyType: 'flat', bhkType: '2BHK' } }).missing,
  ['rentBudgetMonthly']);

ok('a legacy-only lead can become matchable without re-typing',
  mapper.isMatchable(legacyLead).ok === true,
  `missing: [${mapper.isMatchable(legacyLead).missing.join(',')}]`);

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
