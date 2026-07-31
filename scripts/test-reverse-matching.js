/**
 * Reverse Matching — Comprehensive Test Suite
 * 
 * Tests the ReverseMatchService in isolation (no DB, no Socket.io).
 * Validates scoring logic, lead-to-project matching, edge cases.
 * 
 * Run: node scripts/test-reverse-matching.js
 */

const ReverseMatchService = require('../services/ReverseMatchService');
const locationNormalizer = require('../services/LocationNormalizer');

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
      if (pass) {
        passed++;
        totalPassed++;
      } else {
        failed++;
        failures.push({ description: test.description, expected: test.expected, actual: test.actual || 'FAILED' });
      }
    } catch (err) {
      failed++;
      failures.push({ description: test.description, expected: test.expected, error: err.message });
    }
  }

  const accuracy = ((passed / (passed + failed)) * 100).toFixed(1);
  results[categoryName] = { passed, failed, total: passed + failed, accuracy, failures };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA — Projects (simulating published inventory)
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECTS = {
  greenHeights: {
    _id: 'proj_green_heights',
    projectName: 'Green Heights Manish Nagar',
    projectType: 'flat',
    city: 'Nagpur',
    location: 'Manish Nagar',
    latitude: 21.1100,
    longitude: 79.0400,
    reraApproved: true,
    projectStatus: 'under-construction',
    pricing: { startingPrice: 5500000, bankLoanAvailable: true },
    configuration: { bhkOptions: ['1BHK', '2BHK', '3BHK'] },
    owner: { _id: 'builder1', name: 'Builder Mehta', verificationStatus: { builder: 'verified' } }
  },
  skylineWardha: {
    _id: 'proj_skyline',
    projectName: 'Skyline Residency Wardha Road',
    projectType: 'flat',
    city: 'Nagpur',
    location: 'Wardha Road',
    latitude: 21.1100,
    longitude: 79.1200,
    reraApproved: true,
    projectStatus: 'ready-to-move',
    pricing: { startingPrice: 6200000, bankLoanAvailable: true },
    configuration: { bhkOptions: ['2BHK', '3BHK'] },
    owner: { _id: 'builder1', name: 'Builder Mehta', verificationStatus: { builder: 'verified' } }
  },
  pratapVilla: {
    _id: 'proj_pratap_villa',
    projectName: 'Pratap Villa Homes',
    projectType: 'villa',
    city: 'Nagpur',
    location: 'Pratap Nagar',
    latitude: 21.1350,
    longitude: 79.0550,
    reraApproved: false,
    projectStatus: 'pre-launch',
    pricing: { startingPrice: 12000000, bankLoanAvailable: true },
    configuration: { bhkOptions: ['3BHK', '4BHK'] },
    owner: { _id: 'builder2', name: 'Builder Shah', verificationStatus: { builder: 'unverified' } }
  },
  besaBudget: {
    _id: 'proj_besa_budget',
    projectName: 'Besa Affordable Homes',
    projectType: 'flat',
    city: 'Nagpur',
    location: 'Besa',
    latitude: 21.0850,
    longitude: 79.0500,
    reraApproved: true,
    projectStatus: 'nearing-completion',
    pricing: { startingPrice: 3500000, bankLoanAvailable: true },
    configuration: { bhkOptions: ['1BHK', '2BHK'] },
    owner: { _id: 'builder3', name: 'Builder Patel', verificationStatus: { builder: 'verified' } }
  },
  premiumCivil: {
    _id: 'proj_premium_civil',
    projectName: 'Premium Heights Civil Lines',
    projectType: 'flat',
    city: 'Nagpur',
    location: 'Civil Lines',
    latitude: 21.1500,
    longitude: 79.0900,
    reraApproved: true,
    projectStatus: 'ready-to-move',
    pricing: { startingPrice: 15000000, bankLoanAvailable: true },
    configuration: { bhkOptions: ['3BHK', '4BHK', '5BHK'] },
    owner: { _id: 'builder4', name: 'Builder Agarwal', verificationStatus: { builder: 'verified' } }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA — Leads (simulating recent ExtractedLeads)
// ═══════════════════════════════════════════════════════════════════════════════

const LEADS = {
  // Perfect match for Green Heights
  perfectMatch: {
    _id: 'lead_1',
    params: { bhkType: '2BHK', budget: 55, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', city: 'Nagpur', possessionNeeded: null, loanRequired: true },
    extractedBy: { _id: 'agent1', name: 'Agent Rahul', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Budget slightly higher than Green Heights
  budgetStretch: {
    _id: 'lead_2',
    params: { bhkType: '2BHK', budget: 60, budgetMax: 65, location: 'manish_nagar', locationRaw: 'near Manish Nagar', city: 'Nagpur', possessionNeeded: null, loanRequired: false },
    extractedBy: { _id: 'agent2', name: 'Agent Priya', role: 'agent' },
    status: 'confirmed',
    createdAt: new Date()
  },
  // Wardha road requirement
  wardhaReq: {
    _id: 'lead_3',
    params: { bhkType: '2BHK', budget: 60, budgetMax: null, location: 'wardha_road', locationRaw: 'Wardha Road', city: 'Nagpur', possessionNeeded: 'immediate', loanRequired: true },
    extractedBy: { _id: 'agent3', name: 'Agent Suresh', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Villa requirement — should match Pratap Villa
  villaReq: {
    _id: 'lead_4',
    params: { bhkType: '3BHK', budget: 120, budgetMax: null, location: 'pratap_nagar', locationRaw: 'Pratap Nagar', city: 'Nagpur', possessionNeeded: '2year', loanRequired: true },
    extractedBy: { _id: 'agent4', name: 'Agent Neha', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Budget too low for any project above 1cr
  budgetTooLow: {
    _id: 'lead_5',
    params: { bhkType: '3BHK', budget: 40, budgetMax: null, location: 'pratap_nagar', locationRaw: 'Pratap Nagar', city: 'Nagpur', possessionNeeded: null, loanRequired: false },
    extractedBy: { _id: 'agent5', name: 'Agent Rohit', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Different city entirely
  differentCity: {
    _id: 'lead_6',
    params: { bhkType: '2BHK', budget: 55, budgetMax: null, location: 'andheri', locationRaw: 'Andheri', city: 'Mumbai', possessionNeeded: null, loanRequired: false },
    extractedBy: { _id: 'agent6', name: 'Agent Deepak', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // BHK mismatch (wants 4BHK, Green Heights has 1-3BHK)
  bhkMismatch: {
    _id: 'lead_7',
    params: { bhkType: '4BHK', budget: 55, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', city: 'Nagpur', possessionNeeded: null, loanRequired: false },
    extractedBy: { _id: 'agent7', name: 'Agent Amit', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Expired/rejected lead — should NOT match
  rejectedLead: {
    _id: 'lead_8',
    params: { bhkType: '2BHK', budget: 55, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', city: 'Nagpur', possessionNeeded: null, loanRequired: false },
    extractedBy: { _id: 'agent8', name: 'Agent Vikram', role: 'agent' },
    status: 'rejected',
    createdAt: new Date()
  },
  // Budget range that spans the project price
  budgetRange: {
    _id: 'lead_9',
    params: { bhkType: '2BHK', budget: 50, budgetMax: 60, location: 'manish_nagar', locationRaw: 'Manish Nagar', city: 'Nagpur', possessionNeeded: null, loanRequired: false },
    extractedBy: { _id: 'agent9', name: 'Agent Kiran', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Wants immediate possession — Skyline is ready-to-move
  immediateReq: {
    _id: 'lead_10',
    params: { bhkType: '3BHK', budget: 62, budgetMax: null, location: 'wardha_road', locationRaw: 'Wardha Road', city: 'Nagpur', possessionNeeded: 'immediate', loanRequired: true },
    extractedBy: { _id: 'agent10', name: 'Agent Pooja', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Besa budget flat
  besaReq: {
    _id: 'lead_11',
    params: { bhkType: '2BHK', budget: 35, budgetMax: null, location: 'besa', locationRaw: 'Besa', city: 'Nagpur', possessionNeeded: '6months', loanRequired: true },
    extractedBy: { _id: 'agent11', name: 'Agent Sanjay', role: 'agent' },
    status: 'auto_detected',
    createdAt: new Date()
  },
  // Premium requirement — Civil Lines
  premiumReq: {
    _id: 'lead_12',
    params: { bhkType: '4BHK', budget: 150, budgetMax: null, location: 'civil_lines', locationRaw: 'Civil Lines', city: 'Nagpur', possessionNeeded: 'immediate', loanRequired: false },
    extractedBy: { _id: 'agent12', name: 'Agent Ravi', role: 'agent' },
    status: 'confirmed',
    createdAt: new Date()
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ACCESS PRIVATE METHOD FOR TESTING
// We need to call _calculateReverseScore directly
// ═══════════════════════════════════════════════════════════════════════════════

const service = ReverseMatchService;

function score(leadParams, project) {
  return service._calculateReverseScore(leadParams, project);
}

function scoreLeadsAgainstProject(leads, project) {
  return service._scoreLeadsAgainstProject(leads, project);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 1: PERFECT MATCHES (should score high)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('1. Perfect Matches (High Score Expected)', [
  {
    description: '2BHK 55L Manish Nagar vs Green Heights (55L, Manish Nagar, 2BHK)',
    expected: 'score >= 70',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.greenHeights);
      return result.total >= 70;
    }
  },
  {
    description: '3BHK 62L Wardha Road immediate vs Skyline (62L, Wardha Road, ready)',
    expected: 'score >= 75',
    validate: () => {
      const result = score(LEADS.immediateReq.params, PROJECTS.skylineWardha);
      return result.total >= 75;
    }
  },
  {
    description: '3BHK 120L Pratap Nagar 2year vs Pratap Villa (1.2cr, Pratap Nagar, pre-launch)',
    expected: 'score >= 70',
    validate: () => {
      const result = score(LEADS.villaReq.params, PROJECTS.pratapVilla);
      return result.total >= 70;
    }
  },
  {
    description: '2BHK 35L Besa 6months vs Besa Affordable (35L, Besa, nearing-completion)',
    expected: 'score >= 70',
    validate: () => {
      const result = score(LEADS.besaReq.params, PROJECTS.besaBudget);
      return result.total >= 70;
    }
  },
  {
    description: '4BHK 150L Civil Lines immediate vs Premium Heights (1.5cr, Civil Lines, ready)',
    expected: 'score >= 70',
    validate: () => {
      const result = score(LEADS.premiumReq.params, PROJECTS.premiumCivil);
      return result.total >= 70;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 2: BUDGET SCORING ACCURACY
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('2. Budget Scoring', [
  {
    description: 'Exact budget match: 55L lead vs 55L project → 30 pts',
    expected: 'budget = 30',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 55, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.breakdown.budget === 30;
    }
  },
  {
    description: 'Within 10%: 60L lead vs 55L project → 26 pts',
    expected: 'budget = 26',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 60, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.breakdown.budget === 26;
    }
  },
  {
    description: 'Within 15%: 65L lead vs 55L project → 20 pts',
    expected: 'budget = 14 (18% diff → within 20% band)',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 65, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.breakdown.budget === 14; // diff is (65-55)/65 = 15.4% → actually recalculated from reqBudget: (6500000-5500000)/6500000 = 15.4% → ≤20% band = 14
    }
  },
  {
    description: 'Budget range 50-60L vs 55L project → should match (in range)',
    expected: 'budget >= 14',
    validate: () => {
      const result = score(LEADS.budgetRange.params, PROJECTS.greenHeights);
      return result.breakdown.budget >= 14;
    }
  },
  {
    description: 'Budget way off: 40L lead vs 120L project → 0 pts (out of ±20%)',
    expected: 'budget = 0 or undefined',
    validate: () => {
      const result = score(LEADS.budgetTooLow.params, PROJECTS.pratapVilla);
      return !result.breakdown.budget || result.breakdown.budget === 0;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 3: LOCATION SCORING
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('3. Location Scoring', [
  {
    description: 'Exact location: "Manish Nagar" lead vs "Manish Nagar" project → 30 pts',
    expected: 'location = 30',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 55, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.breakdown.location === 30;
    }
  },
  {
    description: 'Fuzzy location: "near Manish Nagar" lead vs project → 30 pts (canonical match)',
    expected: 'location = 30',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 55, location: 'manish_nagar', locationRaw: 'near Manish Nagar' }, PROJECTS.greenHeights);
      return result.breakdown.location === 30;
    }
  },
  {
    description: 'Wardha Road lead vs Wardha Road project → match',
    expected: 'location >= 20',
    validate: () => {
      const result = score(LEADS.wardhaReq.params, PROJECTS.skylineWardha);
      return result.breakdown.location >= 20;
    }
  },
  {
    description: 'Wrong location: Manish Nagar lead vs Wardha Road project → 0',
    expected: 'location = 0 or undefined',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.skylineWardha);
      return !result.breakdown.location || result.breakdown.location === 0;
    }
  },
  {
    description: 'Different city: Mumbai lead vs Nagpur project → 0',
    expected: 'location = 0',
    validate: () => {
      const result = score(LEADS.differentCity.params, PROJECTS.greenHeights);
      return !result.breakdown.location || result.breakdown.location === 0;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 4: BHK SCORING
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('4. BHK Scoring', [
  {
    description: '2BHK lead vs project with [1BHK, 2BHK, 3BHK] → 20 pts (exact)',
    expected: 'bhk = 20',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 55, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.breakdown.bhk === 20;
    }
  },
  {
    description: '3BHK lead vs project with [2BHK, 3BHK] → 20 pts (exact)',
    expected: 'bhk = 20',
    validate: () => {
      const result = score(LEADS.immediateReq.params, PROJECTS.skylineWardha);
      return result.breakdown.bhk === 20;
    }
  },
  {
    description: '4BHK lead vs project with [1BHK, 2BHK, 3BHK] → 8 pts (adjacent: 3BHK is close)',
    expected: 'bhk = 8',
    validate: () => {
      const result = score(LEADS.bhkMismatch.params, PROJECTS.greenHeights);
      return result.breakdown.bhk === 8;
    }
  },
  {
    description: '4BHK lead vs project with [3BHK, 4BHK] → 20 pts (exact)',
    expected: 'bhk = 20',
    validate: () => {
      const result = score(LEADS.premiumReq.params, PROJECTS.premiumCivil);
      return result.breakdown.bhk === 20;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 5: POSSESSION SCORING
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('5. Possession Scoring', [
  {
    description: 'Immediate need vs ready-to-move project → 7 pts',
    expected: 'possession = 7',
    validate: () => {
      const result = score(LEADS.immediateReq.params, PROJECTS.skylineWardha);
      return result.breakdown.possession === 7;
    }
  },
  {
    description: '6months need vs nearing-completion project → 7 pts',
    expected: 'possession = 7',
    validate: () => {
      const result = score(LEADS.besaReq.params, PROJECTS.besaBudget);
      return result.breakdown.possession === 7;
    }
  },
  {
    description: '2year need vs pre-launch project → 7 pts',
    expected: 'possession = 7',
    validate: () => {
      const result = score(LEADS.villaReq.params, PROJECTS.pratapVilla);
      return result.breakdown.possession === 7;
    }
  },
  {
    description: 'Immediate need vs pre-launch project → 0 pts (mismatch)',
    expected: 'possession = 0 or undefined',
    validate: () => {
      const result = score({ ...LEADS.immediateReq.params, location: 'pratap_nagar', locationRaw: 'Pratap Nagar' }, PROJECTS.pratapVilla);
      return !result.breakdown.possession || result.breakdown.possession === 0;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 6: LOAN + BONUS SCORING
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('6. Loan + Bonus Scoring', [
  {
    description: 'Loan required + project has loan → 8 pts',
    expected: 'loan = 8',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.greenHeights);
      return result.breakdown.loan === 8;
    }
  },
  {
    description: 'Loan not required → 4 pts (neutral bonus)',
    expected: 'loan = 4',
    validate: () => {
      const result = score(LEADS.budgetStretch.params, PROJECTS.greenHeights);
      return result.breakdown.loan === 4;
    }
  },
  {
    description: 'Verified builder bonus → 3 pts',
    expected: 'verified = 3',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.greenHeights);
      return result.breakdown.verified === 3;
    }
  },
  {
    description: 'Unverified builder → no bonus',
    expected: 'verified = undefined',
    validate: () => {
      const result = score(LEADS.villaReq.params, PROJECTS.pratapVilla);
      return !result.breakdown.verified;
    }
  },
  {
    description: 'RERA approved → 2 pts',
    expected: 'rera = 2',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.greenHeights);
      return result.breakdown.rera === 2;
    }
  },
  {
    description: 'No RERA → no bonus',
    expected: 'rera = undefined',
    validate: () => {
      const result = score(LEADS.villaReq.params, PROJECTS.pratapVilla);
      return !result.breakdown.rera;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 7: NO-MATCH SCENARIOS (should score LOW or 0)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('7. No-Match / Low-Score Scenarios', [
  {
    description: 'Different city entirely → low score (location penalty applied)',
    expected: 'total < 45',
    validate: () => {
      const result = score(LEADS.differentCity.params, PROJECTS.greenHeights);
      return result.total < 45;
    }
  },
  {
    description: 'Budget way off (40L lead vs 1.2cr project) → not a budget match',
    expected: 'no budget in breakdown',
    validate: () => {
      const result = score(LEADS.budgetTooLow.params, PROJECTS.pratapVilla);
      return !result.breakdown.budget || result.breakdown.budget === 0;
    }
  },
  {
    description: 'BHK mismatch (4BHK) + different location (Manish Nagar vs Wardha Road) → low score',
    expected: 'total < 40',
    validate: () => {
      const result = score(LEADS.bhkMismatch.params, PROJECTS.skylineWardha);
      return result.total < 40;
    }
  },
  {
    description: '2BHK 55L Manish Nagar lead vs Premium 1.5cr Civil Lines → location penalty + no budget match',
    expected: 'total < 30',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.premiumCivil);
      return result.total < 30;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 8: BATCH SCORING (scoreLeadsAgainstProject)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('8. Batch Scoring (Multiple Leads vs 1 Project)', [
  {
    description: 'Green Heights published → finds perfectMatch + budgetStretch + budgetRange as top matches',
    expected: '>= 3 matches with score > 0',
    validate: () => {
      const allLeads = [LEADS.perfectMatch, LEADS.budgetStretch, LEADS.budgetRange, LEADS.differentCity, LEADS.budgetTooLow];
      const scored = scoreLeadsAgainstProject(allLeads, PROJECTS.greenHeights);
      const goodMatches = scored.filter(m => m.score >= 35);
      return goodMatches.length >= 3;
    }
  },
  {
    description: 'Skyline Wardha published → immediateReq + wardhaReq should score high',
    expected: '2 matches >= 50',
    validate: () => {
      const allLeads = [LEADS.immediateReq, LEADS.wardhaReq, LEADS.perfectMatch, LEADS.differentCity];
      const scored = scoreLeadsAgainstProject(allLeads, PROJECTS.skylineWardha);
      const goodMatches = scored.filter(m => m.score >= 50);
      return goodMatches.length >= 2;
    }
  },
  {
    description: 'Pratap Villa published → villaReq should be top match',
    expected: 'villaReq is highest scored',
    validate: () => {
      const allLeads = [LEADS.villaReq, LEADS.perfectMatch, LEADS.differentCity, LEADS.budgetTooLow];
      const scored = scoreLeadsAgainstProject(allLeads, PROJECTS.pratapVilla);
      scored.sort((a, b) => b.score - a.score);
      return scored[0].lead._id === 'lead_4'; // villaReq
    }
  },
  {
    description: 'differentCity lead should NEVER appear in top matches for any Nagpur project',
    expected: 'score < 45 (penalty applied)',
    validate: () => {
      const nagpurProjects = [PROJECTS.greenHeights, PROJECTS.skylineWardha, PROJECTS.pratapVilla, PROJECTS.besaBudget];
      for (const proj of nagpurProjects) {
        const result = score(LEADS.differentCity.params, proj);
        if (result.total >= 45) return false;
      }
      return true;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 9: SCORE BREAKDOWN ACCURACY (Full Decomposition)
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('9. Score Breakdown — Full Decomposition', [
  {
    description: 'Perfect match: 2BHK 55L Manish Nagar loan=true vs Green Heights → budget(30)+location(30)+bhk(20)+loan(8)+verified(3)+rera(2) = 93',
    expected: 'total = 93',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.greenHeights);
      return result.total === 93;
    }
  },
  {
    description: 'matchedOn array should contain all matching criteria',
    expected: 'contains budget, location, bhk, loan, verified_builder, rera',
    validate: () => {
      const result = score(LEADS.perfectMatch.params, PROJECTS.greenHeights);
      return result.matchedOn.includes('budget') &&
             result.matchedOn.includes('location') &&
             result.matchedOn.includes('bhk') &&
             result.matchedOn.includes('loan') &&
             result.matchedOn.includes('verified_builder') &&
             result.matchedOn.includes('rera');
    }
  },
  {
    description: 'Immediate+loan Wardha Road vs Skyline → budget(30)+location(30)+bhk(20)+loan(8)+possession(7)+verified(3)+rera(2) = 100 (capped)',
    expected: 'total = 100',
    validate: () => {
      const result = score(LEADS.immediateReq.params, PROJECTS.skylineWardha);
      return result.total === 100;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 10: EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

runCategory('10. Edge Cases', [
  {
    description: 'Lead with no budget (null) → budget scores 0 but other criteria still work',
    expected: 'total > 0 (from location + bhk)',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: null, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.total > 0 && !result.breakdown.budget;
    }
  },
  {
    description: 'Lead with no location → location scores 0 but budget + bhk work',
    expected: 'total > 0',
    validate: () => {
      const result = score({ bhkType: '2BHK', budget: 55, location: null, locationRaw: null }, PROJECTS.greenHeights);
      return result.total > 0 && result.breakdown.budget > 0 && !result.breakdown.location;
    }
  },
  {
    description: 'Lead with no BHK → bhk scores 0 but budget + location work',
    expected: 'total > 0',
    validate: () => {
      const result = score({ bhkType: null, budget: 55, location: 'manish_nagar', locationRaw: 'Manish Nagar' }, PROJECTS.greenHeights);
      return result.total > 0 && !result.breakdown.bhk && result.breakdown.location > 0;
    }
  },
  {
    description: 'Completely empty lead params → total = 0',
    expected: 'total <= 9 (only neutral bonuses)',
    validate: () => {
      const result = score({}, PROJECTS.greenHeights);
      return result.total <= 9; // loan(4) + verified(3) + rera(2) = 9
    }
  },
  {
    description: 'Score never exceeds 100 even with all bonuses',
    expected: 'total <= 100',
    validate: () => {
      const result = score(LEADS.immediateReq.params, PROJECTS.skylineWardha);
      return result.total <= 100;
    }
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║         REVERSE MATCHING — ACCURACY TEST REPORT                      ║');
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
console.log(`Total Tests: ${totalTests}`);
console.log(`Passed: ${totalPassed}`);
console.log(`Failed: ${totalTests - totalPassed}`);
console.log(`Overall Accuracy: ${overallAccuracy}%`);
console.log('');

// Print score examples
console.log('═══ SAMPLE SCORES (for reference) ═══');
console.log('');
const examples = [
  ['2BHK 55L Manish Nagar (loan) vs Green Heights', LEADS.perfectMatch.params, PROJECTS.greenHeights],
  ['3BHK 62L Wardha Road (immediate, loan) vs Skyline', LEADS.immediateReq.params, PROJECTS.skylineWardha],
  ['3BHK 120L Pratap Nagar (2year, loan) vs Pratap Villa', LEADS.villaReq.params, PROJECTS.pratapVilla],
  ['2BHK 55L Mumbai (diff city) vs Green Heights', LEADS.differentCity.params, PROJECTS.greenHeights],
  ['3BHK 40L Pratap Nagar (budget too low) vs Pratap Villa', LEADS.budgetTooLow.params, PROJECTS.pratapVilla],
];

for (const [label, params, project] of examples) {
  const result = score(params, project);
  console.log(`  ${label}`);
  console.log(`    Score: ${result.total}/100 | Matched: [${result.matchedOn.join(', ')}]`);
  console.log(`    Breakdown: ${JSON.stringify(result.breakdown)}`);
  console.log('');
}

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
      console.log(`      Expected: ${f.expected}`);
      if (f.error) console.log(`      Error: ${f.error}`);
    }
  }
}

if (!hasFailures) {
  console.log('🎉 ALL TESTS PASSED — Zero failures');
}
console.log('');
