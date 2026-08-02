require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const ln = require('../services/LocationNormalizer');

async function run() {
  await connectDB();
  console.log('Loading locations from projects...');
  const result = await ln.loadFromProjects();
  console.log(`Added: ${result.added} | Total aliases: ${result.total}\n`);

  console.log('=== Typo/Fuzzy Tests on Dynamic Locations ===');
  const tests = [
    ['sector20', 'No-space version'],
    ['sektor 20', 'Typo: sektor'],
    ['mouza kalamna nagpur', 'With city suffix'],
    ['butibori', 'Short name'],
    ['hudkeshwar road', 'With road suffix'],
    ['dongargaon', 'Partial name'],
    ['parsodi', 'Short location'],
    ['gotal panjari', 'Two-word location'],
    ['Civil Line', 'Singular (lines→line)'],
  ];

  for (const [input, desc] of tests) {
    const r = ln.normalize(input);
    console.log(`  ${desc.padEnd(25)} "${input}" → canonical: ${r.canonical || 'null'} (conf: ${r.confidence.toFixed(2)})`);
  }

  console.log('\n=== isSameArea Tests ===');
  const sameTests = [
    ['Besa', 'besa road'],
    ['sector 20', 'Sector 20'],
    ['Civil Lines', 'civil line'],
    ['Mouza Kalamna', 'kalamna'],
  ];
  for (const [a, b] of sameTests) {
    const r = ln.isSameArea(a, b);
    console.log(`  "${a}" vs "${b}" → matches: ${r.matches} (${r.method}, conf: ${r.confidence.toFixed(2)})`);
  }

  console.log('\n=== Full NLP Extraction with Dynamic Locations ===');
  const nlp = require('../services/NLPExtractor');
  const msgs = [
    'need 2bhk flat in Sector 20 near Nagpur 25L',
    'I have plot in Mouza Kalamna 20L',
    'chahiye 3bhk Hudkheswar road 30L ready',
  ];
  for (const msg of msgs) {
    const r = nlp.extract(msg);
    console.log(`  "${msg}"`);
    console.log(`    → intent: ${r?.intent} | location: ${r?.params?.locationRaw} | bhk: ${r?.params?.bhkType} | budget: ${r?.params?.budget}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}
run();
