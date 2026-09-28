/**
 * Test: group info attached to match results
 *
 * The match card shows the property's GROUP (name, member count, activity), so
 * attachMatchGroups has to resolve a GroupRoom from the match's project id.
 *
 * Checks:
 *   1. A project that HAS an active project group gets group info with the right
 *      member count.
 *   2. A project with no group gets `group: null` (not undefined) so the client
 *      can distinguish "no group" from "server sent nothing".
 *   3. A soft-deleted (active: false) group is not used.
 *   4. Populated (`project: { _id }`) and raw (`project: ObjectId`) match shapes
 *      both resolve — getMessages populates, older payloads may not.
 *   5. Messages without matchResults are left untouched.
 *
 * Deliberately does NOT create Project documents: attachMatchGroups only queries
 * GroupRoom by project id, so throwaway ids are enough and the test stays cheap.
 *
 * Usage:
 *   node scripts/test-match-group-info.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { connectDB } = require('../config/db');
const GroupRoom = require('../models/GroupRoom');
const User = require('../models/User');
const { attachMatchGroups } = require('../controllers/groupChatController');

const TAG = `match-group-test-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (got ${JSON.stringify(actual)})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  await connectDB();

  let owner;
  const roomIds = [];

  // Throwaway project ids — no Project documents needed.
  const withGroupId = new mongoose.Types.ObjectId();
  const noGroupId = new mongoose.Types.ObjectId();
  const inactiveGroupId = new mongoose.Types.ObjectId();

  try {
    owner = await User.create({
      name: `${TAG}-owner`,
      phone: `6${Date.now()}`.slice(0, 10),
      role: 'builder',
      isActive: true
    });

    const members = [
      { user: owner._id, role: 'admin' },
      { user: new mongoose.Types.ObjectId(), role: 'member' },
      { user: new mongoose.Types.ObjectId(), role: 'member' }
    ];

    const activeRoom = await GroupRoom.create({
      name: `${TAG} Besa Project Group`,
      roomType: 'project',
      project: withGroupId,
      createdBy: owner._id,
      members,
      active: true,
      lastActivity: new Date()
    });
    roomIds.push(activeRoom._id);

    const inactiveRoom = await GroupRoom.create({
      name: `${TAG} Retired Group`,
      roomType: 'project',
      project: inactiveGroupId,
      createdBy: owner._id,
      members: [{ user: owner._id, role: 'admin' }],
      active: false
    });
    roomIds.push(inactiveRoom._id);

    // ── 1 + 4a. Populated project shape, group exists ────────────────────────
    const populatedShape = [{
      messageType: 'requirement_card',
      matchResults: [{ project: { _id: withGroupId, projectName: 'Besa Project' }, score: 92 }]
    }];
    await attachMatchGroups(populatedShape);
    const g = populatedShape[0].matchResults[0].group;
    check('populated shape resolves a group', !!g, true);
    check('group name', g?.name, `${TAG} Besa Project Group`);
    check('member count', g?.membersCount, 3);

    // ── 4b. Raw ObjectId project shape ───────────────────────────────────────
    const rawShape = [{
      messageType: 'requirement_card',
      matchResults: [{ project: withGroupId, score: 80 }]
    }];
    await attachMatchGroups(rawShape);
    check('raw ObjectId shape resolves a group', rawShape[0].matchResults[0].group?.membersCount, 3);

    // ── 2. No group for this project ─────────────────────────────────────────
    const missing = [{
      messageType: 'requirement_card',
      matchResults: [{ project: { _id: noGroupId }, score: 55 }]
    }];
    await attachMatchGroups(missing);
    check('project without a group gets null', missing[0].matchResults[0].group, null);

    // ── 3. Inactive group is ignored ─────────────────────────────────────────
    const inactive = [{
      messageType: 'requirement_card',
      matchResults: [{ project: { _id: inactiveGroupId }, score: 70 }]
    }];
    await attachMatchGroups(inactive);
    check('soft-deleted group ignored', inactive[0].matchResults[0].group, null);

    // ── 5. Messages with no matches are untouched ────────────────────────────
    const plain = [{ messageType: 'text', content: 'hello' }];
    await attachMatchGroups(plain);
    check('plain message untouched', JSON.stringify(plain[0]), JSON.stringify({ messageType: 'text', content: 'hello' }));

    // ── Single-object (non-array) input, as postMessage uses ─────────────────
    const single = {
      messageType: 'requirement_card',
      matchResults: [{ project: { _id: withGroupId }, score: 92 }]
    };
    await attachMatchGroups(single);
    check('single message payload works', single.matchResults[0].group?.membersCount, 3);
  } finally {
    if (roomIds.length) await GroupRoom.deleteMany({ _id: { $in: roomIds } });
    if (owner) await User.deleteOne({ _id: owner._id });
    console.log('\nCleanup done');
    await mongoose.connection.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
