require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const matchEngineV2 = require('../services/MatchEngineV2');
const nlpExtractor = require('../services/NLPExtractor');
const locationNormalizer = require('../services/LocationNormalizer');

async function run() {
  await connectDB();

  const text = 'mujhe ek flat chahiye Besa me 60lakh tak, 2bhk';
  console.log('Input:', text);
  console.log('');

  // Step 1: NLP extraction
  const extraction = nlpExtractor.extract(text);
  console.log('Extraction:', JSON.stringify(extraction?.params, null, 2));
  console.log('');

  // Step 2: Enrich location
  if (extraction?.params?.locationRaw) {
    const norm = locationNormalizer.normalize(extraction.params.locationRaw);
    extraction.params.locationCanonical = norm.canonical;
    extraction.params.locationConfidence = norm.confidence;
    console.log('Location normalized:', norm);
  }
  console.log('');

  // Step 3: Run matching
  console.log('Running MatchEngineV2...');
  const matches = await matchEngineV2.findMatches(extraction.params, {
    limit: 5,
    excludeOwner: '000000000000000000000001', // admin ID
    minScore: 25
  });

  console.log('Matches found:', matches.length);
  matches.forEach((m, i) => {
    console.log(`  ${i+1}. ${m.project.projectName} | ${m.project.location} | Score: ${m.score} | Matched: [${m.matchedOn.join(', ')}]`);
    console.log(`     Breakdown:`, JSON.stringify(m.breakdown));
  });

  if (matches.length === 0) {
    console.log('\n--- DEBUG: checking query manually ---');
    const Project = require('../models/Project');
    
    // Try the exact query MatchEngineV2 would build
    const regex = locationNormalizer.buildLocationRegex(extraction.params.locationRaw || extraction.params.location);
    console.log('Location regex:', regex);
    
    const budgetInUnits = extraction.params.budget * 100000;
    const query = {
      status: 'published',
      owner: { $ne: '000000000000000000000001' },
      'pricing.startingPrice': { $gte: budgetInUnits * 0.8, $lte: budgetInUnits * 1.2 },
    };
    
    console.log('Budget range:', (budgetInUnits*0.8)/100000, 'to', (budgetInUnits*1.2)/100000, 'L');
    
    // Query without location filter first
    const withoutLocation = await Project.find(query)
      .select('projectName location pricing.startingPrice configuration.bhkOptions')
      .lean();
    console.log('\nProjects matching budget (no location filter):', withoutLocation.length);
    withoutLocation.forEach(p => console.log(`  - ${p.projectName} | ${p.location} | ${p.pricing.startingPrice/100000}L`));

    // Now add location
    if (regex) {
      query.$or = [{ location: regex }, { city: regex }];
    }
    const withLocation = await Project.find(query)
      .select('projectName location pricing.startingPrice')
      .lean();
    console.log('\nProjects matching budget + location:', withLocation.length);
    withLocation.forEach(p => console.log(`  - ${p.projectName} | ${p.location} | ${p.pricing.startingPrice/100000}L`));
  }

  await mongoose.disconnect();
}
run();
