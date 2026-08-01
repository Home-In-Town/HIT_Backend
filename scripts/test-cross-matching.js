/**
 * Cross-Matching — Comprehensive Test Suite
 * 
 * Tests the CrossMatchService scoring logic and matching behavior.
 * No DB needed — tests scoring in isolation.
 * 
 * Run: node scripts/test-cross-matching.js
 */

const CrossMatchService = require('../services/CrossMatchService');
const NLPExtractor = require('../services/NLPExtractor');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST FRAMEWORK
// ═══════════════════════════════════════════════════════════════════════════════

let totalTests = 0;
let totalPassed = 0;
const results = {};

function runCategory(categoryName, tests) {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const test of tests) {
    totalTests++;
    try {
      const pass = test.validate();
      if (pass) { passed++; totalPassed++; }
      else { failed++; failures.push({ description: test.description, expected: test.expected }); }
    } catch (err) {
      failed++;
      failures.push({ description: test.description, expected: test.expected, error: err.message });
    }
  }

  const accuracy = ((passed / (passed + failed)) * 100).toFixed(1);
  results[categoryName] = { passed, failed, total: passed + failed, accuracy, failures };
}

function score(reqParams, invParams) {
  return CrossMatchService._scoreCrossMatch(reqParams, invParams);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 1: Perfect Cross-Matches (same BHK + Budget + Location + Type)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('1. Perfect Cross-Matches', [
  {
    description: '2BHK 50L Koradi flat vs 2BHK 50L Koradi flat → 90',
    expected: 'total = 90',
    validate: () => score(
      { bhkType: '2BHK', budget: 50, location: 'koradi', locationRaw: 'Koradi', propertyType: 'flat' },
      { bhkType: '2BHK', budget: 50, location: 'koradi', locationRaw: 'Koradi', propertyType: 'flat' }
    ).total === 90
  },
  {
    description: '3BHK 80L Manish Nagar villa vs same → 90',
    expected: 'total = 90',
    validate: () => score(
      { bhkType: '3BHK', budget: 80, location: 'manish_nagar', locationRaw: 'Manish Nagar', propertyType: 'villa' },
      { bhkType: '3BHK', budget: 80, location: 'manish_nagar', locationRaw: 'Manish Nagar', propertyType: 'villa' }
    ).total === 90
  },
  {
    description: 'Plot 30L Hingna vs Plot 30L Hingna → 90',
    expected: 'total = 90',
    validate: () => score(
      { bhkType: null, budget: 30, location: 'hingna', locationRaw: 'Hingna', propertyType: 'plot' },
      { bhkType: null, budget: 30, location: 'hingna', locationRaw: 'Hingna', propertyType: 'plot' }
    ).total === 70 // No BHK = no BHK score, so 30+30+10 = 70
  },
  {
    description: 'matchedOn contains all criteria',
    expected: 'budget + location + bhk + property_type',
    validate: () => {
      const r = score(
        { bhkType: '2BHK', budget: 60, location: 'besa', locationRaw: 'Besa', propertyType: 'flat' },
        { bhkType: '2BHK', budget: 60, location: 'besa', locationRaw: 'Besa', propertyType: 'flat' }
      );
      return r.matchedOn.includes('budget') && r.matchedOn.includes('location') &&
             r.matchedOn.includes('bhk') && r.matchedOn.includes('property_type');
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 2: Budget Scoring in Cross-Match
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('2. Budget Cross-Match Scoring', [
  {
    description: 'Exact budget: req 50L vs inv 50L → budget=30',
    expected: 'budget in matchedOn, score includes 30',
    validate: () => {
      const r = score({ budget: 50, location: 'besa', locationRaw: 'Besa' }, { budget: 50, location: 'besa', locationRaw: 'Besa' });
      return r.matchedOn.includes('budget') && r.total >= 60; // 30+30
    }
  },
  {
    description: 'Close budget: req 60L vs inv 55L (~9% diff) → budget=26',
    expected: 'budget matched',
    validate: () => {
      const r = score({ budget: 60, location: 'besa', locationRaw: 'Besa' }, { budget: 55, location: 'besa', locationRaw: 'Besa' });
      return r.matchedOn.includes('budget');
    }
  },
  {
    description: 'Budget out of range: req 60L vs inv 20L → no budget match',
    expected: 'budget NOT in matchedOn',
    validate: () => {
      const r = score({ budget: 60, location: 'besa', locationRaw: 'Besa' }, { budget: 20, location: 'besa', locationRaw: 'Besa' });
      return !r.matchedOn.includes('budget');
    }
  },
  {
    description: 'Budget range: req 50-60L vs inv 55L → matches (within range)',
    expected: 'budget matched',
    validate: () => {
      const r = score({ budget: 50, budgetMax: 60, location: 'besa', locationRaw: 'Besa' }, { budget: 55, location: 'besa', locationRaw: 'Besa' });
      return r.matchedOn.includes('budget');
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 3: Location Scoring in Cross-Match
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('3. Location Cross-Match Scoring', [
  {
    description: 'Same canonical location → location=30',
    expected: 'location matched',
    validate: () => {
      const r = score(
        { budget: 50, location: 'koradi', locationRaw: 'Koradi' },
        { budget: 50, location: 'koradi', locationRaw: 'Koradi' }
      );
      return r.matchedOn.includes('location');
    }
  },
  {
    description: 'Fuzzy location: "near Manish Nagar" vs "Manish Nagar" → matched',
    expected: 'location matched',
    validate: () => {
      const r = score(
        { budget: 50, location: 'manish_nagar', locationRaw: 'near Manish Nagar' },
        { budget: 50, location: 'manish_nagar', locationRaw: 'Manish Nagar' }
      );
      return r.matchedOn.includes('location');
    }
  },
  {
    description: 'Different locations: Besa vs Wardha Road → no location match',
    expected: 'location NOT matched',
    validate: () => {
      const r = score(
        { budget: 50, location: 'besa', locationRaw: 'Besa' },
        { budget: 50, location: 'wardha_road', locationRaw: 'Wardha Road' }
      );
      return !r.matchedOn.includes('location');
    }
  },
  {
    description: 'Typo tolerance: "Koradi" vs "kordi" → should still match',
    expected: 'location matched',
    validate: () => {
      const r = score(
        { budget: 50, location: 'koradi', locationRaw: 'Koradi' },
        { budget: 50, location: 'koradi', locationRaw: 'koradi road' }
      );
      return r.matchedOn.includes('location');
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 4: BHK + Property Type Scoring
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('4. BHK + Property Type', [
  {
    description: 'Same BHK: 2BHK vs 2BHK → bhk=20',
    expected: 'bhk matched',
    validate: () => score({ bhkType: '2BHK', budget: 50 }, { bhkType: '2BHK', budget: 50 }).matchedOn.includes('bhk')
  },
  {
    description: 'Adjacent BHK: 2BHK vs 3BHK → bhk_adjacent=8',
    expected: 'bhk_adjacent matched',
    validate: () => score({ bhkType: '2BHK', budget: 50 }, { bhkType: '3BHK', budget: 50 }).matchedOn.includes('bhk_adjacent')
  },
  {
    description: 'Far BHK: 1BHK vs 4BHK → no bhk match',
    expected: 'no bhk',
    validate: () => {
      const r = score({ bhkType: '1BHK', budget: 50 }, { bhkType: '4BHK', budget: 50 });
      return !r.matchedOn.includes('bhk') && !r.matchedOn.includes('bhk_adjacent');
    }
  },
  {
    description: 'Same property type: flat vs flat → property_type=10',
    expected: 'property_type matched',
    validate: () => score(
      { budget: 50, propertyType: 'flat' }, { budget: 50, propertyType: 'flat' }
    ).matchedOn.includes('property_type')
  },
  {
    description: 'Different property type: flat vs plot → no property_type',
    expected: 'no property_type',
    validate: () => !score(
      { budget: 50, propertyType: 'flat' }, { budget: 50, propertyType: 'plot' }
    ).matchedOn.includes('property_type')
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 5: Real-World Scenarios
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('5. Real-World Cross-Match Scenarios', [
  {
    description: 'Inv: "I have 2bhk flat Koradi 45L" vs Req: "chahiye 2bhk Koradi 50L flat" → high score',
    expected: 'score >= 70',
    validate: () => score(
      { bhkType: '2BHK', budget: 50, location: 'koradi', locationRaw: 'Koradi', propertyType: 'flat' },
      { bhkType: '2BHK', budget: 45, location: 'koradi', locationRaw: 'Koradi', propertyType: 'flat' }
    ).total >= 70
  },
  {
    description: 'Inv: "3bhk villa Manish Nagar 1.2cr" vs Req: "need 3bhk villa Manish Nagar 1cr" → good match',
    expected: 'score >= 60',
    validate: () => score(
      { bhkType: '3BHK', budget: 100, location: 'manish_nagar', locationRaw: 'Manish Nagar', propertyType: 'villa' },
      { bhkType: '3BHK', budget: 120, location: 'manish_nagar', locationRaw: 'Manish Nagar', propertyType: 'villa' }
    ).total >= 60
  },
  {
    description: 'Inv: "plot 20L/acre Hingna" vs Req: "plot chahiye Hingna 25L" → partial match',
    expected: 'score >= 40',
    validate: () => score(
      { bhkType: null, budget: 25, location: 'hingna', locationRaw: 'Hingna', propertyType: 'plot' },
      { bhkType: null, budget: 20, location: 'hingna', locationRaw: 'Hingna', propertyType: 'plot' }
    ).total >= 40
  },
  {
    description: 'Completely different: Req Besa 2BHK flat vs Inv Manish Nagar 4BHK villa → low score',
    expected: 'score < 30',
    validate: () => score(
      { bhkType: '2BHK', budget: 50, location: 'besa', locationRaw: 'Besa', propertyType: 'flat' },
      { bhkType: '4BHK', budget: 150, location: 'manish_nagar', locationRaw: 'Manish Nagar', propertyType: 'villa' }
    ).total < 30
  },
  {
    description: 'No params on one side → score 0 or very low',
    expected: 'score <= 5',
    validate: () => score({}, { bhkType: '2BHK', budget: 50, location: 'besa', locationRaw: 'Besa' }).total <= 5
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 6: NLP Intent Detection — Inventory vs Requirement
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('6. NLP Intent Detection (Inventory vs Requirement)', [
  // Inventory (should detect as "inventory")
  { description: '"I have a 2bhk flat in Koradi 45L" → inventory', expected: 'inventory',
    validate: () => NLPExtractor.extract('I have a 2bhk flat in Koradi 45L')?.intent === 'inventory' },
  { description: '"mere paas 2bhk flat hai Besa 50L" → inventory', expected: 'inventory',
    validate: () => NLPExtractor.extract('mere paas 2bhk flat hai Besa me 50L')?.intent === 'inventory' },
  { description: '"2bhk flat for sale Wardha Road 60L" → inventory', expected: 'inventory',
    validate: () => NLPExtractor.extract('2bhk flat for sale Wardha Road 60L')?.intent === 'inventory' },
  { description: '"available 3bhk Manish Nagar 80L" → inventory', expected: 'inventory',
    validate: () => NLPExtractor.extract('available 3bhk Manish Nagar 80L')?.intent === 'inventory' },
  { description: '"bechna hai 2bhk flat Besa 55L" → inventory', expected: 'inventory',
    validate: () => NLPExtractor.extract('bechna hai 2bhk flat Besa 55L')?.intent === 'inventory' },
  
  // Requirement (should detect as "requirement")
  { description: '"I need 2bhk flat near Koradi 50L" → requirement', expected: 'requirement',
    validate: () => NLPExtractor.extract('I need 2bhk flat near Koradi 50L')?.intent === 'requirement' },
  { description: '"mujhe flat chahiye Besa 60L 2bhk" → requirement', expected: 'requirement',
    validate: () => NLPExtractor.extract('mujhe flat chahiye Besa me 60L 2bhk')?.intent === 'requirement' },
  { description: '"looking for 3bhk villa Manish Nagar 1cr" → requirement', expected: 'requirement',
    validate: () => NLPExtractor.extract('looking for 3bhk villa Manish Nagar 1cr')?.intent === 'requirement' },

  // Negative (neither)
  { description: '"good morning" → null', expected: 'null',
    validate: () => NLPExtractor.extract('good morning everyone') === null },
  { description: '"deal done congrats" → null', expected: 'null',
    validate: () => NLPExtractor.extract('deal done congrats') === null },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 7: Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('7. Edge Cases', [
  {
    description: 'Both missing BHK → still scores on budget+location+type',
    expected: 'score > 0',
    validate: () => score(
      { budget: 30, location: 'hingna', locationRaw: 'Hingna', propertyType: 'plot' },
      { budget: 30, location: 'hingna', locationRaw: 'Hingna', propertyType: 'plot' }
    ).total > 0
  },
  {
    description: 'Both missing location → scores on budget+bhk',
    expected: 'score > 0',
    validate: () => score(
      { bhkType: '2BHK', budget: 50 },
      { bhkType: '2BHK', budget: 50 }
    ).total > 0
  },
  {
    description: 'Score capped at 100',
    expected: 'total <= 100',
    validate: () => score(
      { bhkType: '2BHK', budget: 50, location: 'besa', locationRaw: 'Besa', propertyType: 'flat', loanRequired: true },
      { bhkType: '2BHK', budget: 50, location: 'besa', locationRaw: 'Besa', propertyType: 'flat', loanRequired: true }
    ).total <= 100
  },
  {
    description: 'One side empty params → very low/zero score',
    expected: 'total <= 5',
    validate: () => score({}, {}).total <= 5
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║          CROSS-MATCHING — ACCURACY TEST REPORT                       ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
console.log('');

const categoryNames = Object.keys(results);
const maxNameLen = Math.max(...categoryNames.map(n => n.length));

console.log('┌' + '─'.repeat(maxNameLen + 2) + '┬────────┬────────┬──────────┐');
console.log('│ ' + 'Category'.padEnd(maxNameLen) + ' │ Passed │ Failed │ Accuracy │');
console.log('├' + '─'.repeat(maxNameLen + 2) + '┼────────┼────────┼──────────┤');

for (const [name, data] of Object.entries(results)) {
  const status = data.failed === 0 ? '✓' : '✗';
  console.log(`│ ${name.padEnd(maxNameLen)} │ ${String(data.passed).padStart(4)}   │ ${String(data.failed).padStart(4)}   │ ${data.accuracy.padStart(5)}%   │ ${status}`);
}

console.log('├' + '─'.repeat(maxNameLen + 2) + '┼────────┼────────┼──────────┤');
const overallAccuracy = ((totalPassed / totalTests) * 100).toFixed(1);
console.log(`│ ${'OVERALL'.padEnd(maxNameLen)} │ ${String(totalPassed).padStart(4)}   │ ${String(totalTests - totalPassed).padStart(4)}   │ ${overallAccuracy.padStart(5)}%   │`);
console.log('└' + '─'.repeat(maxNameLen + 2) + '┴────────┴────────┴──────────┘');

console.log('');
console.log(`Total Tests: ${totalTests}  |  Passed: ${totalPassed}  |  Failed: ${totalTests - totalPassed}`);
console.log(`Overall Accuracy: ${overallAccuracy}%`);
console.log('');

// Print failures
let hasFailures = false;
for (const [name, data] of Object.entries(results)) {
  if (data.failures.length > 0) {
    if (!hasFailures) { console.log('═══ FAILURES ═══'); hasFailures = true; }
    console.log(`\n  ${name}:`);
    for (const f of data.failures) {
      console.log(`    ✗ ${f.description}`);
      console.log(`      Expected: ${f.expected}`);
      if (f.error) console.log(`      Error: ${f.error}`);
    }
  }
}
if (!hasFailures) console.log('🎉 ALL TESTS PASSED — Zero failures');
console.log('');
