/**
 * Backfill / Repair: one correctly-linked group per project
 *
 * Historically, project groups were only created as a side effect of lead
 * matching (LeadCaptureService), fire-and-forget with errors swallowed. So:
 *   - projects that were never matched have NO group
 *   - concurrent matches could create DUPLICATE groups (no unique index existed)
 *   - an unpopulated owner could produce a group with createdBy undefined
 *   - manual POST /group-chat/rooms could link a group to any/absent project
 *
 * This script repairs existing data and then builds the uniqueness indexes.
 * It is idempotent — safe to run repeatedly.
 *
 * Order matters: duplicates MUST be merged before the unique index can build.
 *
 * Usage:
 *   node scripts/backfillProjectGroups.js --audit      # report only, no writes
 *   node scripts/backfillProjectGroups.js --dry-run    # report + plan, no writes
 *   node scripts/backfillProjectGroups.js              # repair + build indexes
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Don't let model registration race us to build the unique index before
// duplicates are merged — we build indexes explicitly at the end.
mongoose.set('autoIndex', false);

const { connectDB } = require('../config/db');
const Project = require('../models/Project');
const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const User = require('../models/User');
const {
  ensureProjectGroup,
  projectGroupName
} = require('../services/UniversalGroupService');

const ARGS = process.argv.slice(2);
const AUDIT_ONLY = ARGS.includes('--audit');
const DRY_RUN = ARGS.includes('--dry-run') || AUDIT_ONLY;

const stats = {
  projectsScanned: 0,
  groupsCreated: 0,
  groupsRefreshed: 0,
  duplicateSets: 0,
  duplicatesMerged: 0,
  messagesMoved: 0,
  membersMerged: 0,
  detailsAdopted: 0,
  orphansDeactivated: 0,
  nullLinksDeactivated: 0,
  createdByRepaired: 0,
  memberDupesRemoved: 0,
  failures: []
};

function log(...args) { console.log(...args); }
function section(title) { log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`); }

// ═════════════════════════════════════════════════════════════════════
// AUDIT
// ═════════════════════════════════════════════════════════════════════

async function audit(label) {
  section(`AUDIT ${label}`);

  const liveProjects = await Project.find({ status: { $ne: 'deleted' } })
    .select('_id projectName status')
    .lean();

  const linkedIds = await GroupRoom.distinct('project', { roomType: 'project', active: true });
  const linkedSet = new Set(linkedIds.filter(Boolean).map(id => id.toString()));

  const missing = liveProjects.filter(p => !linkedSet.has(p._id.toString()));

  const duplicates = await GroupRoom.aggregate([
    { $match: { roomType: 'project', active: true, project: { $ne: null } } },
    { $group: { _id: '$project', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } }
  ]);

  const nullLinked = await GroupRoom.countDocuments({
    roomType: 'project', active: true, project: null
  });

  const noCreator = await GroupRoom.countDocuments({
    roomType: 'project', active: true,
    $or: [{ createdBy: { $exists: false } }, { createdBy: null }]
  });

  // Dangling: group points at a project row that no longer exists.
  const activeProjectRooms = await GroupRoom.find({ roomType: 'project', active: true })
    .select('_id project').lean();
  const allProjectIds = new Set(
    (await Project.find({}).select('_id').lean()).map(p => p._id.toString())
  );
  const dangling = activeProjectRooms.filter(
    r => r.project && !allProjectIds.has(r.project.toString())
  );

  const multiDetails = await GroupMessage.aggregate([
    { $match: { isProjectDetails: true } },
    { $group: { _id: '$room', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]);

  log(`Live projects (status != deleted) : ${liveProjects.length}`);
  log(`Active project groups            : ${activeProjectRooms.length}`);
  log(`Projects WITHOUT a group         : ${missing.length}`);
  log(`Projects with DUPLICATE groups   : ${duplicates.length}`);
  log(`Groups with project: null        : ${nullLinked}`);
  log(`Groups with no createdBy         : ${noCreator}`);
  log(`Groups pointing at dead project  : ${dangling.length}`);
  log(`Rooms with >1 details message    : ${multiDetails.length}`);

  if (missing.length) {
    log(`\n  Missing (first 15):`);
    missing.slice(0, 15).forEach(p =>
      log(`    - ${p._id}  [${p.status}]  ${p.projectName || '(unnamed)'}`)
    );
    if (missing.length > 15) log(`    … and ${missing.length - 15} more`);
  }

  if (duplicates.length) {
    log(`\n  Duplicates (first 15):`);
    duplicates.slice(0, 15).forEach(d =>
      log(`    - project ${d._id} → ${d.n} groups: ${d.ids.join(', ')}`)
    );
  }

  return { liveProjects, missing, duplicates, dangling, nullLinked, noCreator };
}

// ═════════════════════════════════════════════════════════════════════
// REPAIR: merge duplicate groups
// ═════════════════════════════════════════════════════════════════════

/**
 * Keep the richest room (most members, then most messages, then oldest) and
 * fold the others into it so no conversation is lost.
 */
async function mergeDuplicates(duplicates) {
  if (!duplicates.length) return;
  section('MERGE DUPLICATE GROUPS');

  for (const dup of duplicates) {
    stats.duplicateSets++;
    const rooms = await GroupRoom.find({ _id: { $in: dup.ids } });

    const scored = [];
    for (const room of rooms) {
      const msgCount = await GroupMessage.countDocuments({ room: room._id });
      scored.push({ room, msgCount, memberCount: (room.members || []).length });
    }

    scored.sort((a, b) =>
      b.memberCount - a.memberCount ||
      b.msgCount - a.msgCount ||
      new Date(a.room.createdAt) - new Date(b.room.createdAt)
    );

    const keeper = scored[0].room;
    const losers = scored.slice(1).map(s => s.room);

    log(`\nproject ${dup._id}`);
    log(`  keep   ${keeper._id}  (${scored[0].memberCount} members, ${scored[0].msgCount} msgs)`);

    for (const loser of losers) {
      const info = scored.find(s => s.room._id.equals(loser._id));
      log(`  merge  ${loser._id}  (${info.memberCount} members, ${info.msgCount} msgs)`);

      if (DRY_RUN) { stats.duplicatesMerged++; continue; }

      // Derived details messages would collide with the keeper's under the
      // unique index, and they are regenerated anyway — drop them.
      await GroupMessage.deleteMany({
        room: loser._id,
        $or: [{ isProjectDetails: true }, { messageType: 'system', content: { $regex: '^📋' } }]
      });

      const moved = await GroupMessage.updateMany(
        { room: loser._id },
        { $set: { room: keeper._id } }
      );
      stats.messagesMoved += moved.modifiedCount ?? moved.nModified ?? 0;

      // Fold in members the keeper doesn't have yet.
      const keeperIds = new Set((keeper.members || []).map(m => m.user?.toString()).filter(Boolean));
      const toAdd = (loser.members || []).filter(m => m.user && !keeperIds.has(m.user.toString()));
      if (toAdd.length) {
        await GroupRoom.updateOne(
          { _id: keeper._id },
          {
            $push: {
              members: {
                $each: toAdd.map(m => ({
                  user: m.user,
                  role: m.role === 'admin' ? 'member' : (m.role || 'member'),
                  joinedAt: m.joinedAt || new Date()
                }))
              }
            }
          }
        );
        stats.membersMerged += toAdd.length;
      }

      await GroupRoom.updateOne({ _id: loser._id }, { $set: { active: false } });
      stats.duplicatesMerged++;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// REPAIR: wrongly-linked groups
// ═════════════════════════════════════════════════════════════════════

async function repairBrokenLinks(dangling) {
  section('REPAIR BROKEN LINKS');

  // roomType 'project' with no project link — unrepairable, so retire it.
  const nullLinked = await GroupRoom.find({ roomType: 'project', active: true, project: null })
    .select('_id name').lean();
  for (const room of nullLinked) {
    log(`  project:null → deactivate ${room._id} "${room.name}"`);
    if (!DRY_RUN) await GroupRoom.updateOne({ _id: room._id }, { $set: { active: false } });
    stats.nullLinksDeactivated++;
  }

  // Groups whose project row is gone (deleted before the cascade existed).
  for (const room of dangling) {
    log(`  dead project ${room.project} → deactivate ${room._id}`);
    if (!DRY_RUN) await GroupRoom.updateOne({ _id: room._id }, { $set: { active: false } });
    stats.orphansDeactivated++;
  }

  // createdBy missing (the old upsert skipped validators). Repair from the
  // project owner, else a platform admin.
  const noCreator = await GroupRoom.find({
    roomType: 'project', active: true,
    $or: [{ createdBy: { $exists: false } }, { createdBy: null }]
  }).select('_id project').lean();

  if (noCreator.length) {
    const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
    for (const room of noCreator) {
      const project = room.project
        ? await Project.findById(room.project).select('owner').lean()
        : null;
      const fixId = project?.owner || admin?._id;
      if (!fixId) {
        stats.failures.push(`No creator available for room ${room._id}`);
        continue;
      }
      log(`  createdBy missing → ${fixId} on ${room._id}`);
      if (!DRY_RUN) {
        await GroupRoom.updateOne({ _id: room._id }, { $set: { createdBy: fixId } });
      }
      stats.createdByRepaired++;
    }
  }

  // Duplicate member entries from the old read-modify-write push.
  const withMembers = await GroupRoom.find({ roomType: 'project', active: true })
    .select('_id members').lean();
  for (const room of withMembers) {
    const seen = new Set();
    const deduped = [];
    for (const m of room.members || []) {
      const key = m.user?.toString();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    if (deduped.length !== (room.members || []).length) {
      log(`  member dupes → ${room._id} (${room.members.length} → ${deduped.length})`);
      if (!DRY_RUN) {
        await GroupRoom.updateOne({ _id: room._id }, { $set: { members: deduped } });
      }
      stats.memberDupesRemoved += (room.members.length - deduped.length);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// BACKFILL: one group per live project
// ═════════════════════════════════════════════════════════════════════

async function backfillGroups(liveProjects) {
  section('BACKFILL MISSING GROUPS + REFRESH DETAILS');

  for (const stub of liveProjects) {
    stats.projectsScanned++;
    try {
      const before = await GroupRoom.findOne({
        project: stub._id, roomType: 'project', active: true
      }).select('_id').lean();

      if (DRY_RUN) {
        if (!before) {
          log(`  would create group for ${stub._id} "${stub.projectName || '(unnamed)'}"`);
          stats.groupsCreated++;
        }
        continue;
      }

      const result = await ensureProjectGroup(stub._id, null);
      if (!result) {
        stats.failures.push(`ensureProjectGroup returned null for ${stub._id}`);
        continue;
      }

      if (result.isNew) {
        stats.groupsCreated++;
        log(`  created ${result.room._id} → ${projectGroupName(result.project)}`);
      } else {
        stats.groupsRefreshed++;
      }
    } catch (err) {
      stats.failures.push(`${stub._id}: ${err.message}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// INDEXES
// ═════════════════════════════════════════════════════════════════════

async function buildIndexes() {
  section('BUILD UNIQUENESS INDEXES');

  // Legacy details messages get adopted by ensureProjectGroup above; any room
  // still holding two flagged details messages would block the index.
  const multi = await GroupMessage.aggregate([
    { $match: { isProjectDetails: true } },
    { $group: { _id: '$room', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } }
  ]);
  for (const row of multi) {
    const keep = row.ids[0];
    log(`  room ${row._id}: ${row.n} details messages → keeping ${keep}`);
    await GroupMessage.updateMany(
      { _id: { $in: row.ids.filter(id => !id.equals(keep)) } },
      { $set: { isProjectDetails: false } }
    );
    stats.detailsAdopted++;
  }

  try {
    await GroupRoom.createIndexes();
    log('  ✅ GroupRoom indexes built (uniq_active_project_room)');
  } catch (err) {
    log(`  ❌ GroupRoom index build failed: ${err.message}`);
    log('     Duplicates still exist — re-run this script without --dry-run.');
    stats.failures.push(`GroupRoom index: ${err.message}`);
  }

  try {
    await GroupMessage.createIndexes();
    log('  ✅ GroupMessage indexes built (uniq_project_details_per_room)');
  } catch (err) {
    log(`  ❌ GroupMessage index build failed: ${err.message}`);
    stats.failures.push(`GroupMessage index: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════

async function main() {
  log('🔄 Connecting to database…');
  await connectDB();

  if (DRY_RUN) {
    log(AUDIT_ONLY ? '\n🔍 AUDIT ONLY — no writes' : '\n🧪 DRY RUN — no writes');
  }

  const before = await audit('BEFORE');

  if (AUDIT_ONLY) {
    await mongoose.connection.close();
    return;
  }

  await mergeDuplicates(before.duplicates);
  await repairBrokenLinks(before.dangling);
  await backfillGroups(before.liveProjects);

  if (!DRY_RUN) await buildIndexes();

  section('SUMMARY');
  Object.entries(stats).forEach(([k, v]) => {
    if (k === 'failures') return;
    log(`  ${k.padEnd(24)} ${v}`);
  });

  if (stats.failures.length) {
    log(`\n  ⚠️  ${stats.failures.length} failure(s):`);
    stats.failures.slice(0, 20).forEach(f => log(`    - ${f}`));
  }

  if (!DRY_RUN) await audit('AFTER');

  await mongoose.connection.close();
  log('\n✅ Done.');
}

main().catch(async (err) => {
  console.error('\n❌ Fatal:', err);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
