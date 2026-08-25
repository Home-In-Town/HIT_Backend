/**
 * Inventory feature integration test.
 *
 * Safe to run against the real DB: it creates a throwaway project,
 * exercises the InventoryService end-to-end, and deletes it at the end
 * (even if an assertion fails).
 *
 * Run:  node scripts/test-inventory.js
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Project = require('../models/Project');
const inventoryService = require('../services/InventoryService');

let passed = 0;
let failed = 0;

function assert(label, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${extra ? '  (' + extra + ')' : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${extra ? '  (' + extra + ')' : ''}`);
  }
}

async function run() {
  await connectDB();

  let project;
  try {
    // 1. Create a throwaway project with two BHK options + a couple of plots
    project = await Project.create({
      projectName: '__TEST__ Inventory Project',
      projectType: 'flat',
      status: 'draft',
      configuration: { bhkOptions: ['2BHK', '3BHK'] },
      layoutEntities: [
        { id: 'p1', type: 'subplot', status: 'available', plotNumber: 'A-1' },
        { id: 'p2', type: 'subplot', status: 'available', plotNumber: 'A-2' }
      ]
    });
    console.log('\nCreated test project:', project._id.toString());

    // 2. Seed skeleton from configuration
    const seed = inventoryService.seedFromConfiguration(project);
    assert('seedFromConfiguration returns one row per bhkOption', seed.length === 2, `${seed.length} rows`);

    // 3. Set inventory: 2BHK x30 (2 pre-sold), 3BHK x18
    await inventoryService.setInventory(project._id, [
      { label: '2BHK', totalUnits: 30, soldUnits: 2 },
      { label: '3BHK', totalUnits: 18 }
    ]);
    let fresh = await Project.findById(project._id).lean();
    const twoBhk = fresh.inventory.unitTypes.find((u) => u.label === '2BHK');
    assert('2BHK availableUnits derived to 28', twoBhk.availableUnits === 28, `got ${twoBhk.availableUnits}`);
    assert('rolled-up totalUnits = 48', fresh.inventory.totalUnits === 48, `got ${fresh.inventory.totalUnits}`);
    assert('rolled-up availableUnits = 46', fresh.inventory.availableUnits === 46, `got ${fresh.inventory.availableUnits}`);
    assert('rolled-up soldUnits = 2', fresh.inventory.soldUnits === 2, `got ${fresh.inventory.soldUnits}`);

    // 4. Sell one 2BHK (simulates deal closed_won)
    let res = await inventoryService.sellUnit(project._id, '2BHK');
    assert('sellUnit("2BHK") applied', res.applied === true, res.reason);
    fresh = await Project.findById(project._id).lean();
    const twoBhkAfter = fresh.inventory.unitTypes.find((u) => u.label === '2BHK');
    assert('2BHK available 28 -> 27', twoBhkAfter.availableUnits === 27, `got ${twoBhkAfter.availableUnits}`);
    assert('2BHK sold 2 -> 3', twoBhkAfter.soldUnits === 3, `got ${twoBhkAfter.soldUnits}`);
    assert('totals recomputed: sold = 3', fresh.inventory.soldUnits === 3, `got ${fresh.inventory.soldUnits}`);

    // 5. Case/space-insensitive resolution: "3 bhk" should hit "3BHK"
    res = await inventoryService.sellUnit(project._id, '3 bhk');
    assert('sellUnit("3 bhk") resolves to 3BHK', res.applied === true && res.unitType === '3BHK', res.reason);

    // 6. Plot layout sync: a subplot should have flipped to sold
    fresh = await Project.findById(project._id).lean();
    const soldPlots = (fresh.layoutEntities || []).filter((e) => e.status === 'sold').length;
    assert('at least one subplot flipped to sold', soldPlots >= 1, `${soldPlots} sold plots`);

    // 7. Unresolved unit type when >1 type and no match -> not applied, flagged
    res = await inventoryService.sellUnit(project._id, '5BHK');
    assert('unknown unit type is not applied', res.applied === false, res.reason);
    assert('unknown unit type flags builder confirmation', res.needsBuilderConfirmation === true);

    // 8. Never oversell: drain 3BHK below zero
    for (let i = 0; i < 25; i++) await inventoryService.sellUnit(project._id, '3BHK');
    fresh = await Project.findById(project._id).lean();
    const threeBhk = fresh.inventory.unitTypes.find((u) => u.label === '3BHK');
    assert('3BHK availableUnits never negative', threeBhk.availableUnits === 0, `got ${threeBhk.availableUnits}`);
    assert('3BHK soldUnits capped at total (18)', threeBhk.soldUnits === 18, `got ${threeBhk.soldUnits}`);

    // 9. Selling a sold-out type reports no_available_units
    res = await inventoryService.sellUnit(project._id, '3BHK');
    assert('sold-out type returns no_available_units', res.reason === 'no_available_units', res.reason);
  } catch (err) {
    failed++;
    console.error('\nUNEXPECTED ERROR:', err);
  } finally {
    // Cleanup: always remove the throwaway project
    if (project) {
      await Project.findByIdAndDelete(project._id);
      console.log('\nCleaned up test project.');
    }
    await mongoose.disconnect();
  }

  console.log(`\n================  RESULT: ${passed} passed, ${failed} failed  ================\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
