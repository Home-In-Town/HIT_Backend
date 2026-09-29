/**
 * Backfill: one company-level group per builder
 *
 * Builder groups are created by the project lifecycle (ProjectController's
 * syncGroupForProject), so only builders who create or edit a property AFTER
 * that hook shipped would get one. This script creates the missing groups for
 * everyone who already owns properties.
 *
 * Mirrors the hook's scope: any owner with at least one non-deleted project.
 * Whether those projects are published only affects DISCOVERABILITY, which
 * getRooms decides at read time — so a draft-only builder correctly gets a group
 * that nobody else can see yet.
 *
 * Idempotent: ensureBuilderGroup finds an existing group instead of creating a
 * second one, and re-syncs its name. Safe to run repeatedly.
 *
 * Usage:
 *   node scripts/backfillBuilderGroups.js --dry-run   # report only, no writes
 *   node scripts/backfillBuilderGroups.js             # create groups + index
 */

require('dotenv').config();
const mongoose = require('mongoose');

// The unique index must not be built by model registration before duplicates
// (if any somehow exist) are dealt with — we build it explicitly at the end.
mongoose.set('autoIndex', false);

const { connectDB } = require('../config/db');
const Project = require('../models/Project');
const GroupRoom = require('../models/GroupRoom');
const User = require('../models/User');
const { ensureBuilderGroup, builderGroupName } = require('../services/UniversalGroupService');

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

function section(title) {
  console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);
}

async function main() {
  await connectDB();

  const stats = { owners: 0, existing: 0, created: 0, skipped: [], failures: [] };

  section(DRY_RUN ? 'AUDIT (no writes)' : 'BACKFILL BUILDER GROUPS');

  // Every owner who has at least one live project.
  const ownerIds = await Project.distinct('owner', { status: { $ne: 'deleted' } });
  const owners = ownerIds.filter(Boolean);
  stats.owners = owners.length;
  console.log(`Owners with at least one live project: ${owners.length}`);

  // Which of them already have an active builder group.
  const existingRooms = await GroupRoom.find({
    roomType: 'builder',
    active: true,
    builder: { $in: owners }
  }).select('builder name').lean();
  const haveGroup = new Map(existingRooms.map(r => [String(r.builder), r.name]));
  stats.existing = existingRooms.length;
  console.log(`Already have a builder group:          ${existingRooms.length}`);
  console.log(`Missing:                               ${owners.length - existingRooms.length}\n`);

  for (const ownerId of owners) {
    const key = String(ownerId);

    const user = await User.findById(ownerId).select('name companyName role isActive').lean();
    if (!user) {
      stats.skipped.push(`${key} — user not found`);
      continue;
    }

    const label = builderGroupName(user);
    const published = await Project.countDocuments({ owner: ownerId, status: 'published' });

    if (haveGroup.has(key)) {
      const current = haveGroup.get(key);
      const rename = current !== label ? `  (name will sync: "${current}" -> "${label}")` : '';
      console.log(`  exists   ${label} [${user.role}] ${published} published${rename}`);
      if (!DRY_RUN) {
        // Still call through so an out-of-date group name gets corrected.
        await ensureBuilderGroup(user, null);
      }
      continue;
    }

    if (DRY_RUN) {
      console.log(`  WOULD CREATE  ${label} [${user.role}] ${published} published`);
      continue;
    }

    try {
      const result = await ensureBuilderGroup(user, null);
      if (!result) {
        // ensureBuilderGroup returns null for roles that should not own a
        // company group (e.g. a plain 'user' who somehow owns a project).
        stats.skipped.push(`${label} [${user.role}] — not an eligible role`);
        console.log(`  skipped  ${label} [${user.role}] — role not eligible`);
        continue;
      }
      stats.created++;
      console.log(`  created  ${label} [${user.role}] ${published} published -> room ${result.room._id}`);
    } catch (err) {
      stats.failures.push(`${label}: ${err.message}`);
      console.log(`  FAILED   ${label}: ${err.message}`);
    }
  }

  if (!DRY_RUN) {
    section('BUILD UNIQUENESS INDEX');
    try {
      await GroupRoom.collection.createIndex(
        { builder: 1 },
        {
          unique: true,
          partialFilterExpression: { roomType: 'builder', active: true },
          name: 'uniq_active_builder_room'
        }
      );
      console.log('uniq_active_builder_room ready');
    } catch (err) {
      console.log(`Index build failed: ${err.message}`);
      stats.failures.push(`index: ${err.message}`);
    }
  }

  section('SUMMARY');
  console.log(`owners scanned : ${stats.owners}`);
  console.log(`already existed: ${stats.existing}`);
  console.log(`created        : ${stats.created}`);
  console.log(`skipped        : ${stats.skipped.length}`);
  stats.skipped.forEach(s => console.log(`   - ${s}`));
  console.log(`failures       : ${stats.failures.length}`);
  stats.failures.forEach(f => console.log(`   - ${f}`));
  if (DRY_RUN) console.log('\nDRY RUN — nothing was written.');

  await mongoose.connection.close();
  process.exit(stats.failures.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nBackfill crashed:', err);
  process.exit(1);
});
