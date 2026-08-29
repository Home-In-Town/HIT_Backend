/**
 * test-property-type-matching.js
 *
 * Rough accuracy harness for property-type matching (no DB required).
 * Tests two things:
 *   1) PropertyTypeNormalizer.normalize() maps varied inputs to the right family/category
 *   2) MatchEngineV2._scorePropertyType() gives sensible scores for requirement × project
 *      across every property type on the upload form.
 *
 * Run: node scripts/test-property-type-matching.js
 */

const ptn = require('../services/PropertyTypeNormalizer');
const matchEngine = require('../services/MatchEngineV2');

let pass = 0, fail = 0;
const failures = [];

function check(desc, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else { fail++; failures.push(`${desc}\n     got: ${actual}  expected: ${expected}`); }
  return ok;
}

// ── PART A: Normalizer — every upload-form label maps to a family/category ──
console.log('\n=== PART A: Normalizer (form labels → family/category) ===\n');

const normCases = [
  // [input, expectedFamily, expectedCategory]
  ['Apartment / Flat', 'flat', 'residential'],
  ['Villa', 'villa', 'residential'],
  ['Independent House', 'independent_house', 'residential'],
  ['Row House', 'row_house', 'residential'],
  ['Township', 'township', 'residential'],
  ['Residential Plot', 'plot', 'residential'],
  ['Farm House', 'farm_house', 'residential'],
  ['Farm Land', 'farm_land', 'residential'],
  ['Studio Apartment', 'studio', 'residential'],
  ['Penthouse', 'penthouse', 'residential'],
  ['Duplex', 'duplex', 'residential'],
  ['Office Space', 'office', 'commercial'],
  ['Retail', 'retail', 'commercial'],
  ['Showroom', 'showroom', 'commercial'],
  ['Commercial Plot / Land', 'commercial_plot', 'commercial'],
  ['Industry', 'industry', 'commercial'],
  ['Co-working Space', 'coworking', 'commercial'],
  ['Warehouse / Storage', 'warehouse', 'commercial'],
  ['Hospitality', 'hospitality', 'commercial'],
  ['Residential + Retail', 'mixed_use', 'mixed_use'],
  ['Residential + Commercial Plot', 'mixed_use', 'mixed_use'],
  ['Mixed-Use Tower', 'mixed_use', 'mixed_use'],
  ['Integrated Development', 'mixed_use', 'mixed_use'],
  // chat/legacy values
  ['flat', 'flat', 'residential'],
  ['plot', 'plot', 'residential'],
  ['villa', 'villa', 'residential'],
  ['shop', 'retail', 'commercial'],
  ['office', 'office', 'commercial'],
  // free text
  ['2bhk flat in manish nagar', 'flat', 'residential'],
  ['commercial plot needed', 'commercial_plot', 'commercial'],
  ['farm house on wardha road', 'farm_house', 'residential'],
  ['zameen chahiye', 'plot', 'residential'],
  ['dukaan for rent', 'retail', 'commercial'],
];

for (const [input, ef, ec] of normCases) {
  const n = ptn.normalize(input);
  const okF = n.family === ef;
  const okC = n.category === ec;
  if (okF && okC) { pass++; console.log(`  PASS  "${input}" → ${n.family} / ${n.category}`); }
  else { fail++; failures.push(`normalize("${input}") → ${n.family}/${n.category}  expected ${ef}/${ec}`); console.log(`  FAIL  "${input}" → ${n.family} / ${n.category}   (expected ${ef} / ${ec})`); }
}

// ── PART B: Type scoring — requirement type × project type ──
console.log('\n=== PART B: Property-type match scoring (req × project) ===\n');

// Helper to build a minimal project with a given type expression.
const proj = (fields) => ({ pricing: {}, configuration: {}, ...fields });

// expectedBand: 'high' (>=14), 'mid' (7..13), 'low' (1..6), 'zero' (0)
const scoreCases = [
  // exact family
  ['flat seeker × flat project', 'flat', proj({ projectType: 'flat' }), 'high'],
  ['villa seeker × villa project (form label)', 'villa', proj({ category: 'Residential', propertyType: 'Villa' }), 'high'],
  ['plot seeker × residential plot project', 'plot', proj({ category: 'Residential', propertyType: 'Residential Plot' }), 'high'],
  ['office seeker × office project', 'office', proj({ category: 'Commercial', propertyType: 'Office Space' }), 'high'],
  ['commercial plot × commercial plot', 'commercial_plot', proj({ category: 'Commercial', propertyType: 'Commercial Plot / Land' }), 'high'],
  ['farm house × farm house', 'farm_house', proj({ category: 'Residential', propertyType: 'Farm House' }), 'high'],

  // related family (partial credit)
  ['flat seeker × studio project', 'flat', proj({ category: 'Residential', propertyType: 'Studio Apartment' }), 'mid'],
  ['villa seeker × independent house', 'villa', proj({ category: 'Residential', propertyType: 'Independent House' }), 'mid'],
  ['plot seeker × farm land', 'plot', proj({ category: 'Residential', propertyType: 'Farm Land' }), 'mid'],
  ['office seeker × coworking', 'office', proj({ category: 'Commercial', propertyType: 'Co-working Space' }), 'mid'],

  // same category, different family (partial credit — mid tier)
  ['flat seeker × villa project', 'flat', proj({ category: 'Residential', propertyType: 'Villa' }), 'mid'],
  ['office seeker × warehouse', 'office', proj({ category: 'Commercial', propertyType: 'Warehouse / Storage' }), 'mid'],

  // cross category (mismatch)
  ['flat seeker × office project', 'flat', proj({ category: 'Commercial', propertyType: 'Office Space' }), 'zero'],
  ['office seeker × residential flat', 'office', proj({ category: 'Residential', propertyType: 'Apartment / Flat' }), 'zero'],

  // mixed use
  ['mixed-use seeker × mixed-use project', 'Residential + Retail', proj({ category: 'Mixed Use', propertyType: 'Mixed-Use Tower' }), 'high'],
  ['mixed-use seeker × residential project (partial)', 'Mixed-Use Tower', proj({ category: 'Residential', propertyType: 'Villa' }), 'mid'],
  ['flat seeker × mixed-use project (contained)', 'flat', proj({ category: 'Mixed Use', propertyType: 'Residential + Retail' }), 'mid'],

  // legacy project with only projectType
  ['flat seeker × legacy projectType=flat', 'flat', proj({ projectType: 'flat' }), 'high'],
  ['plot seeker × legacy projectType=plot', 'plot', proj({ projectType: 'plot' }), 'high'],
  ['office seeker × legacy projectType=commercial', 'office', proj({ projectType: 'commercial' }), 'high'],

  // requirement gives no type → neutral (small, non-zero)
  ['no-type seeker × any project', undefined, proj({ category: 'Residential', propertyType: 'Villa' }), 'low'],
];

function band(score) {
  if (score >= 14) return 'high';
  if (score >= 7) return 'mid';
  if (score >= 1) return 'low';
  return 'zero';
}

for (const [desc, reqType, project, expectedBand] of scoreCases) {
  const s = matchEngine._scorePropertyType({ propertyType: reqType }, project);
  const b = band(s.score);
  const ok = b === expectedBand;
  if (ok) { pass++; console.log(`  PASS  ${desc}  → ${s.score} pts [${b}] (${s.method})`); }
  else { fail++; failures.push(`${desc} → ${s.score} pts [${b}]  expected [${expectedBand}]  (${s.method})`); console.log(`  FAIL  ${desc}  → ${s.score} pts [${b}] expected [${expectedBand}] (${s.method})`); }
}

// ── PART C: Land types skip BHK (sanity) ──
console.log('\n=== PART C: Land-type BHK skip ===\n');
for (const t of ['plot', 'Residential Plot', 'Commercial Plot / Land', 'Farm Land']) {
  const isLand = ptn.isLandType(t);
  check(`isLandType("${t}")`, isLand, true) && console.log(`  PASS  "${t}" treated as land (BHK skipped)`);
}
for (const t of ['flat', 'Villa', 'Office Space']) {
  const isLand = ptn.isLandType(t);
  check(`isLandType("${t}") is false`, isLand, false) && console.log(`  PASS  "${t}" NOT land (BHK applies)`);
}

// ── Summary ──
const total = pass + fail;
const acc = ((pass / total) * 100).toFixed(1);
console.log('\n════════════════════════════════════════');
console.log(`  RESULTS: ${pass}/${total} passed  →  ${acc}% accuracy`);
console.log('════════════════════════════════════════');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
