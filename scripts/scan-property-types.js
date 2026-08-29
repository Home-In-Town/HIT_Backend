/**
 * scan-property-types.js
 *
 * Read-only scan of published projects to see what property types exist in the
 * DB, so we can pick real projects to test the improved MatchEngineV2 against.
 *
 * Shows:
 *   - distribution by legacy projectType, by category, by propertyType
 *   - how each distinct type NORMALIZES via PropertyTypeNormalizer
 *   - a compact table of projects usable as test targets
 *
 * Run: node scripts/scan-property-types.js
 */

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Project = require('../models/Project');
const ptn = require('../services/PropertyTypeNormalizer');

function tally(arr, keyFn) {
  const m = {};
  for (const x of arr) {
    const k = keyFn(x) || '(none)';
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

async function run() {
  await connectDB();

  const projects = await Project.find({ status: 'published' })
    .select('projectName projectType category propertyType city location pricing.startingPrice configuration.bhkOptions')
    .lean();

  console.log(`\n===== PUBLISHED PROJECTS: ${projects.length} total =====\n`);

  console.log('--- Distribution by legacy projectType ---');
  tally(projects, p => p.projectType).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

  console.log('\n--- Distribution by category ---');
  tally(projects, p => p.category).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

  console.log('\n--- Distribution by propertyType (form label) ---');
  tally(projects, p => p.propertyType).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

  console.log('\n--- How each distinct type normalizes (family / category) ---');
  const distinctTypes = new Set();
  projects.forEach(p => {
    if (p.propertyType) distinctTypes.add(p.propertyType);
    if (p.projectType) distinctTypes.add(p.projectType);
  });
  [...distinctTypes].sort().forEach(t => {
    const n = ptn.normalize(t);
    console.log(`  "${t}"  →  ${n.family || '-'} / ${n.category || '-'}`);
  });

  console.log('\n--- Projects usable as test targets (grouped by normalized family) ---');
  const byFamily = {};
  for (const p of projects) {
    const n = ptn.fromProject(p);
    const fam = n.family || (n.category ? `[${n.category}]` : '(untyped)');
    (byFamily[fam] = byFamily[fam] || []).push(p);
  }
  for (const [fam, list] of Object.entries(byFamily).sort()) {
    console.log(`\n  ### ${fam}  (${list.length})`);
    list.slice(0, 6).forEach(p => {
      const price = p.pricing?.startingPrice ? (p.pricing.startingPrice / 100000).toFixed(0) + 'L' : 'N/A';
      const bhk = (p.configuration?.bhkOptions || []).join(',') || '-';
      const loc = p.location || p.city || '-';
      console.log(`     • ${(p.projectName || '?').slice(0, 30).padEnd(30)} | ${loc.slice(0, 20).padEnd(20)} | ${price.padStart(6)} | bhk:${bhk}`);
    });
    if (list.length > 6) console.log(`     … +${list.length - 6} more`);
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error('SCAN ERROR:', err.message); process.exit(1); });
