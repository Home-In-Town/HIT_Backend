/**
 * Lead Matching self-test (no DB writes, no network).
 *
 * Exercises the three pure brains of the lead-matching system:
 *   1. NLPExtractor     — free-text → params
 *   2. LeadFlowEngine   — slot flow, validation, branching, buildLeadParams
 *   3. MatchEngineV2     — scoring a requirement against a project
 *
 * Run: node scripts/leadMatchingSelfTest.js
 */

const nlp = require('../services/NLPExtractor');
const flow = require('../services/LeadFlowEngine');
const matchEngine = require('../services/MatchEngineV2');
const locationNormalizer = require('../services/LocationNormalizer');
const propertyTypeNormalizer = require('../services/PropertyTypeNormalizer');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` → ${detail}` : ''}`);
  }
}

function section(t) { console.log(`\n=== ${t} ===`); }

// ─────────────────────────────────────────────────────────────
section('1. NLPExtractor — requirement extraction');

const r1 = nlp.extract('Client needs 2BHK flat near Manish Nagar budget 60 lakh');
check('detects a requirement', !!r1, String(r1));
if (r1) {
  check('bhkType = 2BHK', r1.params.bhkType === '2BHK', r1.params.bhkType);
  check('budget = 60 (lakhs)', r1.params.budget === 60, r1.params.budget);
  check('propertyType = flat', r1.params.propertyType === 'flat', r1.params.propertyType);
  check('location captured', !!r1.params.locationRaw, r1.params.locationRaw);
  check('confidence > 0.5', r1.confidence > 0.5, r1.confidence);
}

const r2 = nlp.extract('mujhe 3bhk chahiye besa mein 75 lakh tak');
check('Hindi/Romanized detected', !!r2, String(r2));
if (r2) {
  check('Hindi bhkType = 3BHK', r2.params.bhkType === '3BHK', r2.params.bhkType);
  check('Hindi budget = 75', r2.params.budget === 75, r2.params.budget);
}

const r3 = nlp.extract('50 to 70 lakh budget 2bhk wardha road');
check('budget range parsed', !!r3 && r3.params.budget === 50 && r3.params.budgetMax === 70,
  r3 ? `${r3.params.budget}-${r3.params.budgetMax}` : 'null');

const rent = nlp.extract('need 2bhk flat on rent in civil lines 25000 monthly');
check('rent transactionType', !!rent && rent.params.transactionType === 'rent',
  rent ? rent.params.transactionType : 'null');

const inv = nlp.extract('I have a 3BHK flat available in Besa 80 lakh');
check('inventory intent', !!inv && inv.intent === 'inventory', inv ? inv.intent : 'null');

check('greeting ignored', nlp.extract('Good morning everyone') === null);
check('sold-notice ignored', nlp.extract('That flat is sold now') === null);
check('too-short ignored', nlp.extract('ok') === null);

// ─────────────────────────────────────────────────────────────
section('2. LeadFlowEngine — slot flow & validation');

check('intent is first slot', flow.nextSlot(null, {}).id === 'intent');

// BUY path
let slots = { intent: 'buy' };
let next = flow.nextSlot('buy', slots);
check('buy → propertyType next', next.id === 'propertyType', next.id);
slots.propertyType = 'Flats / Apartments';
next = flow.nextSlot('buy', slots);
check('flat → bhk asked', next.id === 'bhk', next.id);
slots.bhk = '2BHK';
next = flow.nextSlot('buy', slots);
// City is asked BEFORE locality/size so locality suggestions can be biased to it.
check('after bhk → city', next.id === 'city', next.id);
slots.city = 'Nagpur';
next = flow.nextSlot('buy', slots);
check('after city → location', next.id === 'location', next.id);
slots.location = 'Civil Lines';
next = flow.nextSlot('buy', slots);
check('after location → area (size)', next.id === 'area', next.id);

// Land must NOT ask bhk
for (const landType of ['Residential Plots', 'Agricultural Land', 'Commercial / Industrial Land']) {
  const ls = { intent: 'buy', propertyType: landType };
  check(`"${landType}" skips bhk`, flow.nextSlot('buy', ls).id !== 'bhk', flow.nextSlot('buy', ls).id);
}

// SELL path branches through category
const sellNext = flow.nextSlot('sell', { intent: 'sell' });
check('sell → category next', sellNext.id === 'category', sellNext.id);

// ── New category set ──
const catSlot = flow.getSlot('category');
const catValues = catSlot.options.map((o) => o.value);
// The category list was widened from 4 to 6 real buckets (+ an "Other" chip) so
// sellers of farm land / industrial units aren't forced into a wrong bucket.
check('6 categories + Other offered', catValues.length === 7, catValues.join(','));
check('categories cover resi/comm/plot/agri/industrial/pg',
  ['Residential', 'Commercial', 'Plots / Land', 'Agricultural / Farm Land', 'Industrial', 'PG / Co-living']
    .every((v) => catValues.includes(v)),
  catValues.join(','));
check('category offers an Other option', catValues.includes('other'), catValues.join(','));

// Detailed sell types follow the chosen category
const ptd = flow.getSlot('propertyTypeDetailed');
const resTypes = flow.resolveOptions(ptd, { category: 'Residential' }).map((o) => o.value);
check('Residential detailed types include Flats / Apartments',
  resTypes.includes('Flats / Apartments'), resTypes.join(','));
const landTypes = flow.resolveOptions(ptd, { category: 'Plots / Land' }).map((o) => o.value);
check('Plots / Land detailed types include Residential Plot',
  landTypes.includes('Residential Plot'), landTypes.join(','));
// Agricultural land now has its own category instead of being buried under Plots.
const agriTypes = flow.resolveOptions(ptd, { category: 'Agricultural / Farm Land' }).map((o) => o.value);
check('Agricultural category includes Agricultural Land',
  agriTypes.includes('Agricultural Land'), agriTypes.join(','));
// An "Other"/custom category must still yield a usable picklist, not an empty one.
const fallbackTypes = flow.resolveOptions(ptd, { category: 'other' }).map((o) => o.value);
check('Other category falls back to the full type list',
  fallbackTypes.length > 10, String(fallbackTypes.length));

// ── New urgency set ──
const urg = flow.getSlot('urgency');
const urgValues = urg.options.map((o) => o.value);
check('urgency options are immediate/1_2_months/exploring',
  ['immediate', '1_2_months', 'exploring'].every((v) => urgValues.includes(v)),
  urgValues.join(','));
// 'other' was REMOVED from urgency on purpose: params.urgency is a hard enum on
// ExtractedLead, so a free-text urgency threw on save and aborted the whole lead.
// Skip covers "none of these" instead.
check('urgency does NOT offer Other (enum-safe)',
  !urgValues.includes('other'), urgValues.join(','));
check('urgency is skippable', urg.skippable === true);
check('urgency accepts immediate', flow.parseAndValidate(urg, 'immediate', {}).valid === true);

// Buy property type list must carry the full catalogue
const ptBuy = flow.getSlot('propertyType').options.map((o) => o.value);
check('buy property types include all families',
  ['Flats / Apartments', 'Shops & Showrooms', 'Warehouses & Godowns', 'Residential Plot',
   'Agricultural Land', 'Industrial Shed', 'PG (Paying Guest)'].every((v) => ptBuy.includes(v)),
  String(ptBuy.length));
check('buy property type catalogue is substantially wider', ptBuy.length >= 30, String(ptBuy.length));

// Validation
const bhkSlot = flow.getSlot('bhk');
check('valid choice accepted', flow.parseAndValidate(bhkSlot, '2BHK', {}).valid === true);
check('custom bhk (4bhk) accepted via allowCustom',
  flow.parseAndValidate(bhkSlot, '4bhk', {}).valid === true);

const phoneSlot = flow.getSlot('contact');
check('valid phone accepted', flow.parseAndValidate(phoneSlot, '9876543210', {}).valid === true);
check('short phone rejected', flow.parseAndValidate(phoneSlot, '12345', {}).valid === false);
check('phone with +91 normalised',
  flow.parseAndValidate(phoneSlot, '+91 98765 43210', {}).value === '9876543210');

const areaSlot = flow.getSlot('area');
const areaOk = flow.parseAndValidate(areaSlot, { value: '1200', unit: 'sqft' }, {});
check('area with unit accepted', areaOk.valid && areaOk.value.amount === 1200 && areaOk.value.unit === 'sqft');
check('non-numeric area rejected', flow.parseAndValidate(areaSlot, 'abc', {}).valid === false);
check('bad unit rejected', flow.parseAndValidate(areaSlot, { value: 10, unit: 'furlong' }, {}).valid === false);

const priceSlot = flow.getSlot('expectedPrice');
check('price in cr accepted', flow.parseAndValidate(priceSlot, { value: 1.5, unit: 'cr' }, {}).valid === true);

// Skippable
const urgencySlot = flow.getSlot('urgency');
check('skippable slot accepts skip', flow.parseAndValidate(urgencySlot, '__skipped__', {}).valid === true);
check('required slot rejects skip', flow.parseAndValidate(areaSlot, '__skipped__', {}).valid === false);

// Completion + params
const buyComplete = {
  intent: 'buy', propertyType: 'Flats / Apartments', bhk: '2BHK',
  area: { amount: 1000, unit: 'sqft' }, location: 'Besa', city: 'Nagpur',
  expectedPrice: { amount: 60, unit: 'lakh' }, contact: '9876543210',
};
check('buy flow complete', flow.isComplete('buy', buyComplete) === true);
check('incomplete detected', flow.isComplete('buy', { intent: 'buy' }) === false);

const built = flow.buildLeadParams('buy', buyComplete);
check('direction = buy', built.direction === 'buy', built.direction);
check('transactionType = buy', built.transactionType === 'buy', built.transactionType);
check('budget normalised to lakhs = 60', built.params.budget === 60, built.params.budget);
check('bhkType carried', built.params.bhkType === '2BHK', built.params.bhkType);
check('area carried', built.params.area === 1000, built.params.area);

const crBuilt = flow.buildLeadParams('sell', { ...buyComplete, intent: 'sell', expectedPrice: { amount: 1.5, unit: 'cr' } });
check('cr → 150 lakhs', crBuilt.params.budget === 150, crBuilt.params.budget);

// ── Places autocomplete: resolved place objects accepted AND persisted ──
const citySlot = flow.getSlot('city');
const locSlot = flow.getSlot('location');
check('city slot uses the place-autocomplete control', citySlot.inputType === 'city', citySlot.inputType);
check('city accepts plain typed text', flow.parseAndValidate(citySlot, 'Nagpur', {}).valid === true);

const cityPlace = {
  text: 'Nagpur', placeId: 'ChIJ_city', formattedAddress: 'Nagpur, Maharashtra, India',
  latitude: 21.1458, longitude: 79.0882, state: 'Maharashtra', postalCode: '',
};
const cityParsed = flow.parseAndValidate(citySlot, cityPlace, {});
check('city accepts a resolved place object', cityParsed.valid === true);
check('city keeps the placeId', cityParsed.value?.placeId === 'ChIJ_city', String(cityParsed.value?.placeId));
check('city rejects an empty place object', flow.parseAndValidate(citySlot, {}, {}).valid === false);

const locPlace = {
  text: 'Civil Lines', placeId: 'ChIJ_loc', formattedAddress: 'Civil Lines, Nagpur, Maharashtra 440001, India',
  latitude: 21.1539, longitude: 79.0821, state: 'Maharashtra', postalCode: '440001',
};
check('location accepts a resolved place object', flow.parseAndValidate(locSlot, locPlace, {}).valid === true);

const placeBuilt = flow.buildLeadParams('buy', { ...buyComplete, city: cityPlace, location: locPlace });
check('city stored as display text', placeBuilt.params.city === 'Nagpur', String(placeBuilt.params.city));
check('location stored as display text', placeBuilt.params.location === 'Civil Lines', String(placeBuilt.params.location));
check('placeId persisted', placeBuilt.params.placeId === 'ChIJ_loc', String(placeBuilt.params.placeId));
check('formattedAddress persisted',
  placeBuilt.params.formattedAddress === 'Civil Lines, Nagpur, Maharashtra 440001, India',
  String(placeBuilt.params.formattedAddress));
check('coordinates persisted (locality preferred over city)',
  placeBuilt.params.latitude === 21.1539 && placeBuilt.params.longitude === 79.0821,
  `${placeBuilt.params.latitude},${placeBuilt.params.longitude}`);
check('state persisted', placeBuilt.params.state === 'Maharashtra', String(placeBuilt.params.state));
check('postalCode persisted', placeBuilt.params.postalCode === '440001', String(placeBuilt.params.postalCode));

// Locality typed manually → fall back to the city's coordinates.
const mixedBuilt = flow.buildLeadParams('buy', { ...buyComplete, city: cityPlace, location: 'Somewhere' });
check('falls back to city coordinates', mixedBuilt.params.latitude === 21.1458, String(mixedBuilt.params.latitude));

// Plain-text answers must still work (no coordinates, no crash).
const textBuilt = flow.buildLeadParams('buy', { ...buyComplete, city: 'Nagpur', location: 'Besa' });
check('typed-only city/location still works',
  textBuilt.params.city === 'Nagpur' && textBuilt.params.location === 'Besa' && textBuilt.params.latitude === null,
  `${textBuilt.params.city}/${textBuilt.params.location}/${textBuilt.params.latitude}`);

// Pruning: flat→land should drop bhk
const pruned = flow.pruneInapplicable('buy', { ...buyComplete, propertyType: 'Residential Plots' });
check('prune drops bhk for land', pruned.bhk === undefined, JSON.stringify(pruned.bhk));

// ─────────────────────────────────────────────────────────────
section('3. MatchEngineV2 — scoring');

const project = {
  _id: 'p1', projectName: 'Skyline', city: 'Nagpur', location: 'Besa',
  projectType: 'flat', category: 'Residential', propertyType: 'Apartment / Flat',
  projectStatus: 'ready-to-move', reraApproved: true,
  pricing: { startingPrice: 6000000, bankLoanAvailable: true },
  configuration: { bhkOptions: ['2 BHK', '3 BHK'], carpetAreaRange: '900 - 1200 sqft' },
  owner: { verificationStatus: { builder: 'verified' } },
};

const perfect = matchEngine._calculateScore(
  { bhkType: '2BHK', budget: 60, locationRaw: 'Besa', city: 'Nagpur', propertyType: 'flat', loanRequired: true },
  project
);
check('near-perfect match scores high (>=80)', perfect.score >= 80, perfect.score);
check('matchedOn includes budget', perfect.matchedOn.includes('budget'), perfect.matchedOn.join(','));
check('matchedOn includes bhk', perfect.matchedOn.includes('bhk'), perfect.matchedOn.join(','));
check('confidence > 0.6', perfect.confidence > 0.6, perfect.confidence);

const wrongCity = matchEngine._calculateScore(
  { bhkType: '2BHK', budget: 60, locationRaw: 'Hinjewadi', city: 'Pune', propertyType: 'flat' },
  project
);
check('different city scores lower than same-area', wrongCity.score < perfect.score,
  `${wrongCity.score} vs ${perfect.score}`);

// ── Nearest-match behaviour: a single differing detail must DEGRADE the score,
// never zero it out, so the buyer still sees the closest available stock.
const wayOverBudget = matchEngine._calculateScore(
  { bhkType: '2BHK', budget: 20, locationRaw: 'Besa', city: 'Nagpur', propertyType: 'flat' },
  project
);
check('budget far off still scores (graded, not 0)', (wayOverBudget.breakdown.budget.score || 0) > 0,
  wayOverBudget.breakdown.budget.score);
check('far-off budget flagged near', wayOverBudget.breakdown.budget.near === true);
check('far-off budget NOT claimed as matched', !wayOverBudget.matchedOn.includes('budget'),
  wayOverBudget.matchedOn.join(','));
check('budget mismatch ranks below exact budget', wayOverBudget.score < perfect.score,
  `${wayOverBudget.score} vs ${perfect.score}`);

const bhkMismatch = matchEngine._calculateScore(
  { bhkType: '5BHK', budget: 60, locationRaw: 'Besa', city: 'Nagpur', propertyType: 'flat' },
  project
);
check('BHK off by 2 still scores (graded)', (bhkMismatch.breakdown.bhk.score || 0) > 0,
  bhkMismatch.breakdown.bhk.score);
check('BHK off by 2 NOT claimed as matched', !bhkMismatch.matchedOn.includes('bhk'),
  bhkMismatch.matchedOn.join(','));

const adjacent = matchEngine._calculateScore(
  { bhkType: '4BHK', budget: 60, locationRaw: 'Besa', city: 'Nagpur', propertyType: 'flat' },
  project
);
check('adjacent BHK gets partial credit', (adjacent.breakdown.bhk.score || 0) > 0,
  adjacent.breakdown.bhk.score);
check('adjacent BHK outranks off-by-2',
  adjacent.breakdown.bhk.score > bhkMismatch.breakdown.bhk.score,
  `${adjacent.breakdown.bhk.score} vs ${bhkMismatch.breakdown.bhk.score}`);

// Koradi asked, only Besa/Nagpur stock exists → must still score via city.
const nearbyLocality = matchEngine._calculateScore(
  { bhkType: '2BHK', budget: 60, locationRaw: 'Koradi', city: 'Nagpur', propertyType: 'flat' },
  project
);
check('other locality, same city → city-level credit',
  (nearbyLocality.breakdown.location.score || 0) >= 8, nearbyLocality.breakdown.location.score);
check('same-city nearest match clears a usable score', nearbyLocality.score >= 25,
  nearbyLocality.score);
check('same city outranks different city',
  nearbyLocality.breakdown.location.score > wrongCity.breakdown.location.score,
  `${nearbyLocality.breakdown.location.score} vs ${wrongCity.breakdown.location.score}`);

// Construction-status preference must be soft, not disqualifying.
const statusMismatch = matchEngine._calculateScore(
  { bhkType: '2BHK', budget: 60, locationRaw: 'Besa', city: 'Nagpur', propertyType: 'flat', possessionNeeded: '2year' },
  project
);
check('status mismatch keeps partial credit', (statusMismatch.breakdown.possession.score || 0) > 0,
  statusMismatch.breakdown.possession.score);
check('status mismatch NOT claimed as matched', !statusMismatch.matchedOn.includes('possession'),
  statusMismatch.matchedOn.join(','));

check('score never exceeds 100', perfect.score <= 100, perfect.score);
check('matchQuality exact for high score', matchEngine._matchQuality(85) === 'exact');
check('matchQuality close for mid score', matchEngine._matchQuality(50) === 'close');
check('matchQuality nearest for low score', matchEngine._matchQuality(20) === 'nearest');

// Query tiers must widen progressively so one bad detail can't empty the net.
const tiers = matchEngine._buildQueryTiers(
  { bhkType: '2BHK', budget: 60, locationRaw: 'Koradi', city: 'Nagpur', propertyType: 'flat' },
  'ownerX'
);
check('multiple query tiers built', tiers.length >= 3, tiers.length);
check('tier 0 constrains budget', !!tiers[0]['pricing.startingPrice']);
check('a later tier drops budget constraint',
  tiers.some((t) => !t['pricing.startingPrice']), 'none');
check('last tier is published-only',
  tiers[tiers.length - 1].status === 'published' && !tiers[tiers.length - 1].city,
  JSON.stringify(tiers[tiers.length - 1]));
check('all tiers exclude the owner', tiers.every((t) => !!t.owner));

const landReq = matchEngine._calculateScore(
  { budget: 60, locationRaw: 'Besa', city: 'Nagpur', propertyType: 'plot' },
  project
);
check('plot requirement skips bhk scoring', landReq.breakdown.bhk.skipped === true,
  JSON.stringify(landReq.breakdown.bhk));

// ─────────────────────────────────────────────────────────────
section('4. Normalizers');

const norm = locationNormalizer.normalize('Besa');
check('location normalize returns canonical', !!norm && !!norm.canonical, JSON.stringify(norm));
const same = locationNormalizer.isSameArea('Besa', 'Besa', null);
check('same area matches', same.matches === true, JSON.stringify(same));
const diff = locationNormalizer.isSameArea('Besa', 'Hinjewadi', null);
check('different area does not match', diff.matches === false, JSON.stringify(diff));

check('flat is not land type', propertyTypeNormalizer.isLandType('flat') === false);
check('plot is land type', propertyTypeNormalizer.isLandType('plot') === true);
// New schema labels must normalise correctly too.
check('"Flats / Apartments" is not land', propertyTypeNormalizer.isLandType('Flats / Apartments') === false);
check('"Residential Plots" is land', propertyTypeNormalizer.isLandType('Residential Plots') === true);
check('"Agricultural Land" is land', propertyTypeNormalizer.isLandType('Agricultural Land') === true);
check('"Commercial / Industrial Land" is land',
  propertyTypeNormalizer.isLandType('Commercial / Industrial Land') === true);
check('"Office Spaces" is not land', propertyTypeNormalizer.isLandType('Office Spaces') === false);

// ═══════════════════════════════════════════════════════════════════════════
// 4. FuzzyText — typo / spacing tolerance
//
// Real listings are typed by hand on phones. One misspelled field used to mean
// zero matches, so these are the cases that must survive, plus the
// false-positive guards that stop "nearest match" becoming "any match".
// ═══════════════════════════════════════════════════════════════════════════
const fuzzy = require('../services/FuzzyText');

const near = (a, b, min, label) =>
  check(label || `fuzzy: "${a}" ~ "${b}"`, fuzzy.compare(a, b).score >= min,
    `${fuzzy.compare(a, b).score.toFixed(2)} ${fuzzy.compare(a, b).method}`);
const notNear = (a, b, max, label) =>
  check(label || `fuzzy: "${a}" !~ "${b}"`, fuzzy.compare(a, b).score <= max,
    `${fuzzy.compare(a, b).score.toFixed(2)} ${fuzzy.compare(a, b).method}`);

// Spacing differences must be free.
near('civillines', 'Civil Lines', 0.95);
near('NewManishNagar', 'New Manish Nagar', 0.95);
near('Manish  Nagar ', 'manish nagar', 0.95);
// Abbreviations expand before distance is measured.
near('Manish Ngr', 'Manish Nagar', 0.85);
near('Pratap Colny', 'Pratap Colony', 0.85);
// Noise words are ignored.
near('near Manish Nagar road', 'Manish Nagar', 0.85);
near('Manish Nagar Extension', 'manish nagar', 0.8);
// Genuine typos.
near('Manesh Nagar', 'Manish Nagar', 0.7);
near('Cival Lines', 'Civil Lines', 0.7);
// Word order.
near('Nagar Manish', 'Manish Nagar', 0.85);
// Guards: short words one letter apart are DIFFERENT places, not typos.
notNear('Besa', 'Bela', 0.5);
notNear('Koradi', 'Wardha', 0.3);
notNear('Civil Lines', 'Dhantoli', 0.3);
notNear('Pune', 'Pimpri', 0.5);

// City canonicalisation.
const cityNear = (a, b) =>
  check(`city: "${a}" ~ "${b}"`, fuzzy.compareCity(a, b).score >= 1,
    `${fuzzy.compareCity(a, b).score.toFixed(2)} ${fuzzy.compareCity(a, b).method}`);
cityNear('Ngpur', 'Nagpur');
cityNear('nagpr', 'NAGPUR');
cityNear('Nagpour', 'Nagpur');
cityNear('Poona', 'Pune');
cityNear('Bombay', 'Mumbai');
cityNear('Nasik', 'Nashik');
check('different cities stay different',
  fuzzy.compareCity('Nagpur', 'Pune').score < 0.5,
  String(fuzzy.compareCity('Nagpur', 'Pune').score));

// ═══════════════════════════════════════════════════════════════════════════
// 5. Every schema option value must normalise to a known type family
//
// A property type the normaliser can't place scores 0 on type matching, which
// silently degrades every match involving it.
// ═══════════════════════════════════════════════════════════════════════════
const schema = require('../config/leadSlotSchema');
for (const [cat, list] of Object.entries(schema.CATEGORY_TYPES)) {
  const unresolved = list.filter((t) => {
    const r = propertyTypeNormalizer.normalize(t);
    return !r.family && !r.category;
  });
  check(`all "${cat}" types normalise`, unresolved.length === 0, unresolved.join(','));
}
const unresolvedAll = schema.ALL_PROPERTY_TYPES.filter((t) => {
  const r = propertyTypeNormalizer.normalize(t);
  return !r.family && !r.category;
});
check('all buy/rent types normalise', unresolvedAll.length === 0, unresolvedAll.join(','));
check('"other" resolves to the other family',
  propertyTypeNormalizer.normalize('other').family === 'other');

// Spot-check the newly added families.
[['Commercial Complex', 'retail'], ['Restaurants & Cafes', 'hospitality'],
 ['Schools & Institutes', 'institutional'], ['Hospitals & Clinics', 'healthcare'],
 ['Orchard / Plantation', 'farm_land'], ['Single Room', 'pg_coliving'],
 ['Industrial Shed', 'industry'], ['Service Apartment', 'serviced_apartment'],
 ['Corner Plot', 'plot'], ['Studio Apartment / 1RK', 'studio'],
].forEach(([raw, want]) => {
  const got = propertyTypeNormalizer.normalize(raw).family;
  check(`"${raw}" → ${want}`, got === want, String(got));
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Lead retention must outlive the matching lookback
//
// Leads used to be hard-deleted after 15 days while ReverseMatchService looked
// back 180 — so the lookback found almost nothing and buy leads were unusable.
// ═══════════════════════════════════════════════════════════════════════════
const ExtractedLeadModel = require('../models/ExtractedLead');
check('lead retention is at least 180 days',
  ExtractedLeadModel.LEAD_RETENTION_DAYS >= 180,
  String(ExtractedLeadModel.LEAD_RETENTION_DAYS));
const freshLead = new ExtractedLeadModel({ extractedBy: new (require('mongoose').Types.ObjectId)() });
const daysUntilExpiry = (freshLead.expiresAt - Date.now()) / (24 * 3600 * 1000);
check('a new lead does not expire within 180 days',
  daysUntilExpiry >= 180, `${Math.round(daysUntilExpiry)} days`);

// ─────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`Failed: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('All lead-matching checks passed.');
