/**
 * NLP Lead Matching — Comprehensive Accuracy Test Suite
 * 
 * Tests ALL scenarios and reports accuracy scores per category.
 * Run: node scripts/test-nlp-accuracy.js
 */

const nlpExtractor = require('../services/NLPExtractor');
const locationNormalizer = require('../services/LocationNormalizer');
const conversationContext = require('../services/ConversationContext');

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
    const { input, expected, description, context } = test;
    let actual;

    try {
      if (test.method === 'extractAll') {
        actual = nlpExtractor.extractAll(input, context || {});
      } else if (test.method === 'normalize') {
        actual = locationNormalizer.normalize(input);
      } else if (test.method === 'isSameArea') {
        actual = locationNormalizer.isSameArea(input, test.input2, test.coords);
      } else {
        actual = nlpExtractor.extract(input, context || {});
      }

      const pass = test.validate(actual);
      if (pass) {
        passed++;
        totalPassed++;
      } else {
        failed++;
        failures.push({ description, input, expected, actual: summarize(actual) });
      }
    } catch (err) {
      failed++;
      failures.push({ description, input, error: err.message });
    }
  }

  const accuracy = ((passed / (passed + failed)) * 100).toFixed(1);
  results[categoryName] = { passed, failed, total: passed + failed, accuracy, failures };
}

function summarize(obj) {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) return `[${obj.length} items]`;
  if (obj?.params) {
    const p = obj.params;
    return `${p.bhkType||'-'} ${p.budget||'-'}L ${p.location||'-'} (${obj.intent}, conf:${obj.confidence?.toFixed(2)})`;
  }
  if (obj?.canonical) return `canonical:${obj.canonical} conf:${obj.confidence?.toFixed(2)}`;
  if (obj?.matches !== undefined) return `matches:${obj.matches} method:${obj.method}`;
  return JSON.stringify(obj).substring(0, 100);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 1: ENGLISH INTENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('1. English Intent Detection', [
  {
    input: 'I am looking for a 2bhk flat near Manish Nagar 60L',
    description: 'Standard "looking for"',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement' && r?.confidence >= 0.7
  },
  {
    input: 'need 2bhk flat manish nagar 60 lakh',
    description: 'Simple "need"',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'client wants 3bhk villa in Pratap Nagar 1.2cr',
    description: '"client wants" (high confidence)',
    expected: 'requirement conf>=0.75',
    validate: (r) => r?.intent === 'requirement' && r?.confidence >= 0.8
  },
  {
    input: 'anyone has 2bhk flat in besa area 50L?',
    description: '"anyone has" query',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'want to buy 2bhk near wardha road 65L',
    description: '"want to buy"',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'can someone suggest 3bhk flat near manish nagar',
    description: '"can someone suggest"',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'buyer for 2bhk 60L manish nagar',
    description: '"buyer for"',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: '2bhk 60L manish nagar flat loan required',
    description: 'Implicit (no intent word, 3+ params)',
    expected: 'implicit_requirement',
    validate: (r) => r?.intent === 'implicit_requirement' || r?.intent === 'requirement'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 2: HINDI INTENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('2. Hindi Intent Detection', [
  {
    input: '2bhk flat chahiye Manish Nagar mein 60 lakh',
    description: 'chahiye (need)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement' && r?.params?.bhkType === '2BHK'
  },
  {
    input: '3bhk lena hai besa mein 80L',
    description: 'lena hai (want to take)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement' && r?.params?.bhkType === '3BHK'
  },
  {
    input: 'client ka requirement hai 2bhk manish nagar 55L',
    description: 'client ka requirement',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'koi flat dila do 2bhk 60L wardha road',
    description: 'dila do (get me)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'ghar chahiye 2bhk 50 lakh manewada area',
    description: 'ghar chahiye (need house)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement' && r?.params?.location === 'manewada'
  },
  {
    input: 'do bhk chahiye besa mein 50L budget',
    description: 'Hindi number "do" (2)',
    expected: 'requirement, 2BHK',
    validate: (r) => r?.intent === 'requirement' && r?.params?.bhkType === '2BHK'
  },
  {
    input: 'makan chahiye 3bhk manish nagar 70 lakh',
    description: 'makan chahiye (need house)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'kharidna hai 2bhk flat besa 55L',
    description: 'kharidna hai (want to buy)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 3: MARATHI INTENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('3. Marathi Intent Detection', [
  {
    input: '2bhk flat pahije Manish Nagar javal 55 lakh',
    description: 'pahije (need)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement' && r?.params?.bhkType === '2BHK'
  },
  {
    input: '3bhk ghar pahije wardha road 80L',
    description: 'ghar pahije (need house)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'flat havay 2bhk manish nagar 60 lakh',
    description: 'havay (want/need)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: '2bhk flat shodhat aahe 60L besa',
    description: 'shodhat aahe (searching)',
    expected: 'requirement',
    validate: (r) => r?.intent === 'requirement'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 4: NEGATIVE INTENT (Should NOT trigger extraction)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('4. Negative Intent (False Positive Prevention)', [
  {
    input: 'good morning everyone',
    description: 'Greeting',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'hello, how are you?',
    description: 'Greeting 2',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'deal done, congrats!',
    description: 'Status update',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'thank you so much for the help',
    description: 'Thank you',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'happy diwali to everyone!',
    description: 'Festival greeting',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'welcome to the group',
    description: 'Welcome message',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'sold 2bhk at 55L manish nagar',
    description: 'Sold status (NOT a requirement)',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'suprabhat, aaj ka din achha ho',
    description: 'Hindi greeting',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'ok noted',
    description: 'Short acknowledgment',
    expected: 'null',
    validate: (r) => r === null
  },
  {
    input: 'yes sir',
    description: 'Short response',
    expected: 'null',
    validate: (r) => r === null
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 5: BHK EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('5. BHK Extraction', [
  { input: 'need 1bhk flat 30L', description: '1BHK', expected: '1BHK', validate: (r) => r?.params?.bhkType === '1BHK' },
  { input: 'need 2bhk flat 60L', description: '2BHK', expected: '2BHK', validate: (r) => r?.params?.bhkType === '2BHK' },
  { input: 'need 3 BHK flat 80L', description: '3 BHK (space)', expected: '3BHK', validate: (r) => r?.params?.bhkType === '3BHK' },
  { input: 'need 4bhk villa 2cr', description: '4BHK', expected: '4BHK', validate: (r) => r?.params?.bhkType === '4BHK' },
  { input: 'need two bhk flat 50L', description: 'English word "two"', expected: '2BHK', validate: (r) => r?.params?.bhkType === '2BHK' },
  { input: 'do bhk chahiye 50L', description: 'Hindi "do" (2)', expected: '2BHK', validate: (r) => r?.params?.bhkType === '2BHK' },
  { input: 'teen bhk chahiye 80L', description: 'Hindi "teen" (3)', expected: '3BHK', validate: (r) => r?.params?.bhkType === '3BHK' },
  { input: 'need 1rk near station 15L', description: '1RK', expected: '1RK', validate: (r) => r?.params?.bhkType === '1RK' },
  { input: 'need 2 bedroom flat 60L', description: '2 bedroom', expected: '2BHK', validate: (r) => r?.params?.bhkType === '2BHK' },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 6: BUDGET EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('6. Budget Extraction', [
  { input: 'need 2bhk 60 lakh', description: '60 lakh', expected: '60', validate: (r) => r?.params?.budget === 60 },
  { input: 'need 2bhk 60L', description: '60L shorthand', expected: '60', validate: (r) => r?.params?.budget === 60 },
  { input: 'need 2bhk 55 lac', description: '55 lac', expected: '55', validate: (r) => r?.params?.budget === 55 },
  { input: 'need 3bhk 1.2 crore', description: '1.2 crore = 120L', expected: '120', validate: (r) => r?.params?.budget === 120 },
  { input: 'need 3bhk 1.5cr', description: '1.5cr = 150L', expected: '150', validate: (r) => r?.params?.budget === 150 },
  { input: 'need 2bhk 0.6cr', description: '0.6cr = 60L', expected: '60', validate: (r) => r?.params?.budget === 60 },
  { input: 'need 2bhk 45.5 lakh', description: '45.5 lakh (decimal)', expected: '45.5', validate: (r) => r?.params?.budget === 45.5 },
  {
    input: 'need 2bhk 50 to 60 lakh manish nagar',
    description: '50-60L range',
    expected: 'min:50, max:60',
    validate: (r) => r?.params?.budget === 50 && r?.params?.budgetMax === 60
  },
  {
    input: 'need 2bhk 50-65L manish nagar',
    description: '50-65L (dash)',
    expected: 'min:50, max:65',
    validate: (r) => r?.params?.budget === 50 && r?.params?.budgetMax === 65
  },
  {
    input: 'need 2bhk around 60 lakh manish nagar',
    description: 'around 60L (±10%)',
    expected: 'min:54, max:66, flexible',
    validate: (r) => r?.params?.budget === 54 && r?.params?.budgetMax === 66 && r?.params?.budgetFlexible === true
  },
  {
    input: 'need 2bhk upto 70 lakh manish nagar',
    description: 'upto 70L',
    expected: 'budget:70, max:70',
    validate: (r) => r?.params?.budget === 70 && r?.params?.budgetMax === 70
  },
  {
    input: 'need 2bhk 60L negotiable manish nagar',
    description: '60L negotiable (flexible flag)',
    expected: 'flexible:true',
    validate: (r) => r?.params?.budget === 60 && r?.params?.budgetFlexible === true
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 7: LOCATION EXTRACTION & NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('7. Location Normalization', [
  { input: 'Manish Nagar', method: 'normalize', description: 'Exact name', expected: 'manish_nagar', validate: (r) => r?.canonical === 'manish_nagar' && r?.confidence === 1.0 },
  { input: 'near Manish Nagar', method: 'normalize', description: 'With "near" prefix', expected: 'manish_nagar', validate: (r) => r?.canonical === 'manish_nagar' },
  { input: 'Manish Nagar road', method: 'normalize', description: 'With "road" suffix', expected: 'manish_nagar', validate: (r) => r?.canonical === 'manish_nagar' },
  { input: 'Manish Nagar extension', method: 'normalize', description: 'With "extension"', expected: 'manish_nagar', validate: (r) => r?.canonical === 'manish_nagar' },
  { input: 'manish nagr', method: 'normalize', description: 'Typo (nagr)', expected: 'manish_nagar', validate: (r) => r?.canonical === 'manish_nagar' && r?.confidence >= 0.8 },
  { input: 'behind Manish Nagar', method: 'normalize', description: 'With "behind"', expected: 'manish_nagar', validate: (r) => r?.canonical === 'manish_nagar' },
  { input: 'wardha road', method: 'normalize', description: 'Wardha Road', expected: 'wardha_road', validate: (r) => r?.canonical === 'wardha_road' },
  { input: 'wardha rd', method: 'normalize', description: 'Wardha Rd (abbreviated)', expected: 'wardha_road', validate: (r) => r?.canonical === 'wardha_road' },
  { input: 'pratapnagar', method: 'normalize', description: 'Pratapnagar (no space)', expected: 'pratap_nagar', validate: (r) => r?.canonical === 'pratap_nagar' },
  { input: 'besa road', method: 'normalize', description: 'Besa Road', expected: 'besa', validate: (r) => r?.canonical === 'besa' },
  { input: 'manewada ring road', method: 'normalize', description: 'Manewada ring road', expected: 'manewada', validate: (r) => r?.canonical === 'manewada' },
  { input: 'koradi road', method: 'normalize', description: 'Koradi road', expected: 'koradi', validate: (r) => r?.canonical === 'koradi' },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 8: LOCATION SAME-AREA MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('8. Same Area Detection', [
  { input: 'near manish nagar', input2: 'Manish Nagar', method: 'isSameArea', description: '"near X" == "X"', expected: 'match', validate: (r) => r?.matches === true },
  { input: 'manish nagar road', input2: 'Manish Nagar', method: 'isSameArea', description: '"X road" == "X"', expected: 'match', validate: (r) => r?.matches === true },
  { input: 'manish nagr', input2: 'Manish Nagar', method: 'isSameArea', description: 'Typo match', expected: 'match', validate: (r) => r?.matches === true },
  { input: 'manish nagar', input2: 'Wardha Road', method: 'isSameArea', description: 'Different areas', expected: 'no match', validate: (r) => r?.matches === false },
  { input: 'besa', input2: 'Besa Square', method: 'isSameArea', description: 'Besa variations', expected: 'match', validate: (r) => r?.matches === true },
  {
    input: 'manish nagar', input2: 'Some Project',
    coords: { lat: 21.111, lng: 79.041 },
    method: 'isSameArea',
    description: 'Geo proximity (<2km)',
    expected: 'match via geo',
    validate: (r) => r?.matches === true
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 9: MULTI-LOCATION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('9. Multi-Location Detection', [
  {
    input: 'need 2bhk flat near manish nagar or wardha road 60L',
    description: '"X or Y"',
    expected: '2 locations',
    validate: (r) => r?.params?.locations?.length === 2 && r?.params?.locations?.includes('manish_nagar') && r?.params?.locations?.includes('wardha_road')
  },
  {
    input: 'need 2bhk near besa ya pratap nagar 55L',
    description: '"X ya Y" (Hindi or)',
    expected: '2 locations',
    validate: (r) => r?.params?.locations?.length === 2
  },
  {
    input: 'looking for 2bhk manish nagar 60L',
    description: 'Single location (no split)',
    expected: '1 location',
    validate: (r) => r?.params?.locations?.length === 1
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 10: MULTI-REQUIREMENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('10. Multi-Requirement Detection', [
  {
    input: 'need 2bhk manish nagar 60L and also 3bhk besa 80L',
    method: 'extractAll',
    description: '"and also" separator',
    expected: '2 requirements',
    validate: (r) => r?.length === 2 && r[0]?.params?.bhkType === '2BHK' && r[1]?.params?.bhkType === '3BHK'
  },
  {
    input: 'looking for 2bhk manish nagar 60L 3bhk wardha road 75L',
    method: 'extractAll',
    description: 'Adjacent BHK (no separator)',
    expected: '2 requirements',
    validate: (r) => r?.length === 2
  },
  {
    input: 'need 2bhk manish nagar 60L; 3bhk besa 80L',
    method: 'extractAll',
    description: 'Semicolon separator',
    expected: '2 requirements',
    validate: (r) => r?.length === 2
  },
  {
    input: 'need 2bhk flat manish nagar 60L',
    method: 'extractAll',
    description: 'Single requirement (no split)',
    expected: '1 requirement',
    validate: (r) => r?.length === 1 && r[0]?.params?.bhkType === '2BHK'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 11: FOLLOW-UP / CONVERSATION CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('11. Follow-Up Resolution', [
  {
    input: 'same area but 3bhk',
    description: 'Same area, change BHK',
    context: { previousParams: { bhkType: '2BHK', budget: 60, location: 'manish_nagar', locationRaw: 'Manish Nagar' } },
    expected: '3BHK, 60L, manish_nagar',
    validate: (r) => r?.intent === 'follow_up_requirement' && r?.params?.bhkType === '3BHK' && r?.params?.budget === 60 && r?.params?.location === 'manish_nagar'
  },
  {
    input: 'increase budget to 75L',
    description: 'Increase budget',
    context: { previousParams: { bhkType: '2BHK', budget: 60, location: 'manish_nagar', locationRaw: 'Manish Nagar' } },
    expected: '2BHK, 75L, manish_nagar',
    validate: (r) => r?.intent === 'follow_up_requirement' && r?.params?.budget === 75 && r?.params?.bhkType === '2BHK'
  },
  {
    input: 'bigger flat chahiye',
    description: 'Bigger (+1 BHK)',
    context: { previousParams: { bhkType: '2BHK', budget: 60, location: 'manish_nagar', locationRaw: 'Manish Nagar' } },
    expected: '3BHK (2+1)',
    validate: (r) => r?.intent === 'follow_up_requirement' && r?.params?.bhkType === '3BHK'
  },
  {
    input: 'budget kam karo 50L',
    description: 'Decrease budget (Hindi)',
    context: { previousParams: { bhkType: '2BHK', budget: 60, location: 'manish_nagar', locationRaw: 'Manish Nagar' } },
    expected: '2BHK, 50L',
    validate: (r) => r?.intent === 'follow_up_requirement' && r?.params?.budget === 50
  },
  {
    input: 'wahi area mein but villa chahiye',
    description: 'Same area, change property type',
    context: { previousParams: { bhkType: '3BHK', budget: 120, location: 'pratap_nagar', locationRaw: 'Pratap Nagar', propertyType: 'flat' } },
    expected: 'villa, pratap_nagar',
    validate: (r) => r?.intent === 'follow_up_requirement' && r?.params?.propertyType === 'villa' && r?.params?.location === 'pratap_nagar'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 12: DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('12. Message Deduplication', [
  {
    input: 'need 2bhk manish nagar 60L',
    description: 'First message (should extract)',
    context: { userId: 'dedup_test_user_1' },
    expected: 'extracted',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'need 2bhk manish nagar 60L',
    description: 'Same message repeated (should block)',
    context: { userId: 'dedup_test_user_1' },
    expected: 'null (duplicate)',
    validate: (r) => r === null
  },
  {
    input: 'need 3bhk besa 80L',
    description: 'Different message (should extract)',
    context: { userId: 'dedup_test_user_1' },
    expected: 'extracted',
    validate: (r) => r?.intent === 'requirement'
  },
  {
    input: 'need 2bhk manish nagar 60L',
    description: 'Same text but different user (should extract)',
    context: { userId: 'dedup_test_user_2' },
    expected: 'extracted',
    validate: (r) => r?.intent === 'requirement'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 13: PROPERTY TYPE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('13. Property Type', [
  { input: 'need 2bhk flat 60L', description: 'flat', expected: 'flat', validate: (r) => r?.params?.propertyType === 'flat' },
  { input: 'need plot 40L manish nagar', description: 'plot', expected: 'plot', validate: (r) => r?.params?.propertyType === 'plot' },
  { input: 'need 3bhk villa 1.5cr', description: 'villa', expected: 'villa', validate: (r) => r?.params?.propertyType === 'villa' },
  { input: 'need 3bhk bungalow 2cr', description: 'bungalow→villa', expected: 'villa', validate: (r) => r?.params?.propertyType === 'villa' },
  { input: 'need row house 80L', description: 'row house', expected: 'row_house', validate: (r) => r?.params?.propertyType === 'row_house' },
  { input: 'need shop 30L manish nagar', description: 'shop', expected: 'shop', validate: (r) => r?.params?.propertyType === 'shop' },
  { input: 'need 2bhk apartment 60L', description: 'apartment→flat', expected: 'flat', validate: (r) => r?.params?.propertyType === 'flat' },
  { input: 'zameen chahiye 50L besa', description: 'Hindi: zameen→plot', expected: 'plot', validate: (r) => r?.params?.propertyType === 'plot' },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 14: POSSESSION, LOAN, URGENCY
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('14. Possession / Loan / Urgency', [
  { input: 'need 2bhk 60L ready to move', description: 'Ready to move', expected: 'immediate', validate: (r) => r?.params?.possessionNeeded === 'immediate' },
  { input: 'need 2bhk 60L immediate possession', description: 'Immediate', expected: 'immediate', validate: (r) => r?.params?.possessionNeeded === 'immediate' },
  { input: 'need 2bhk 60L under construction', description: 'Under construction', expected: '1year', validate: (r) => r?.params?.possessionNeeded === '1year' },
  { input: 'need 2bhk 60L new launch', description: 'New launch', expected: '2year', validate: (r) => r?.params?.possessionNeeded === '2year' },
  { input: 'need 2bhk 60L loan required', description: 'Loan required', expected: 'true', validate: (r) => r?.params?.loanRequired === true },
  { input: 'need 2bhk 60L home loan chahiye', description: 'Loan Hindi', expected: 'true', validate: (r) => r?.params?.loanRequired === true },
  { input: 'need 2bhk 60L urgent', description: 'Urgent', expected: 'urgent', validate: (r) => r?.params?.urgency === 'urgent' },
  { input: 'need 2bhk 60L very urgent asap', description: 'Very urgent', expected: 'very_urgent', validate: (r) => r?.params?.urgency === 'very_urgent' },
  { input: 'need 2bhk 60L bahut jaldi', description: 'Hindi very urgent', expected: 'very_urgent', validate: (r) => r?.params?.urgency === 'very_urgent' },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 15: CONFIDENCE CALIBRATION
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('15. Confidence Calibration', [
  {
    input: 'need 2bhk flat near Manish Nagar 60L budget',
    description: 'Golden trio (BHK+Budget+Location) = high confidence',
    expected: 'conf >= 0.85',
    validate: (r) => r?.confidence >= 0.85
  },
  {
    input: 'need flat 60L',
    description: 'Only budget+type (no BHK, no location) = lower',
    expected: 'conf < 0.8',
    validate: (r) => r?.confidence < 0.8
  },
  {
    input: 'need 2bhk 60L manish nagar loan ready',
    description: '5+ params = high confidence',
    expected: 'conf >= 0.9',
    validate: (r) => r?.confidence >= 0.9
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 16: REAL-WORLD MIXED MESSAGES (End-to-End)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('16. Real-World Messages (E2E)', [
  {
    input: 'I am looking for a flat, 2bhk, 60lakh budget, near Manish nagar',
    description: 'Original user example',
    expected: '2BHK, 60L, manish_nagar, flat',
    validate: (r) => r?.params?.bhkType === '2BHK' && r?.params?.budget === 60 && r?.params?.location === 'manish_nagar' && r?.params?.propertyType === 'flat'
  },
  {
    input: 'looking for 2bhk near manish nagr road 55L',
    description: 'Typo + noise word',
    expected: '2BHK, 55L, manish_nagar',
    validate: (r) => r?.params?.bhkType === '2BHK' && r?.params?.budget === 55 && r?.params?.location === 'manish_nagar'
  },
  {
    input: 'client wants 3bhk villa in Pratap Nagar 1.2cr ready possession loan needed',
    description: 'Full param message',
    expected: '3BHK, 120L, pratap_nagar, villa, immediate, loan',
    validate: (r) => r?.params?.bhkType === '3BHK' && r?.params?.budget === 120 && r?.params?.location === 'pratap_nagar' && r?.params?.propertyType === 'villa' && r?.params?.possessionNeeded === 'immediate' && r?.params?.loanRequired === true
  },
  {
    input: 'anyone has 2bhk flat wardha road area 60-65 lakh loan required urgent',
    description: 'Range + loan + urgency',
    expected: '2BHK, 60-65L, wardha_road, loan, urgent',
    validate: (r) => r?.params?.bhkType === '2BHK' && r?.params?.budget === 60 && r?.params?.budgetMax === 65 && r?.params?.loanRequired === true && r?.params?.urgency === 'urgent'
  },
  {
    input: 'mujhe 2bhk chahiye manish nagar ke paas 50 se 60 lakh mein, loan chahiye jaldi',
    description: 'Full Hindi sentence',
    expected: '2BHK, 50-60L, manish_nagar, loan, urgent',
    validate: (r) => r?.params?.bhkType === '2BHK' && r?.params?.budget === 50 && r?.params?.budgetMax === 60 && r?.params?.loanRequired === true
  },
  {
    input: '2bhk flat near besa / pratap nagar 55 to 65L ready possession chahiye',
    description: 'Multi-location + range + Hindi',
    expected: '2BHK, 55-65L, immediate, 2 locations',
    validate: (r) => r?.params?.bhkType === '2BHK' && r?.params?.budget === 55 && r?.params?.possessionNeeded === 'immediate'
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║          NLP LEAD MATCHING — ACCURACY TEST REPORT               ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
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
console.log(`Total Tests: ${totalTests}`);
console.log(`Passed: ${totalPassed}`);
console.log(`Failed: ${totalTests - totalPassed}`);
console.log(`Overall Accuracy: ${overallAccuracy}%`);
console.log('');

// Print failures if any
let hasFailures = false;
for (const [name, data] of Object.entries(results)) {
  if (data.failures.length > 0) {
    if (!hasFailures) {
      console.log('═══ FAILURES ═══');
      hasFailures = true;
    }
    console.log(`\n  ${name}:`);
    for (const f of data.failures) {
      console.log(`    ✗ ${f.description}`);
      console.log(`      Input: "${f.input}"`);
      console.log(`      Expected: ${f.expected}`);
      console.log(`      Actual: ${f.actual || f.error}`);
    }
  }
}

if (!hasFailures) {
  console.log('🎉 ALL TESTS PASSED — Zero failures');
}

console.log('');
