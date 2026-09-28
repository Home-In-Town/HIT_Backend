/**
 * Test: group unread counts
 *
 * Verifies the four behaviours the unread badge depends on:
 *   1. A message from another member counts as unread.
 *   2. Marking the room read drops the count to zero.
 *   3. System messages and the reader's own messages never count.
 *   4. A member who joins later does NOT inherit pre-join messages as unread,
 *      which is the `lastReadAt` → `joinedAt` fallback doing its job.
 *
 * Creates its own throwaway room and users, and deletes them at the end, so it
 * can run against a live database without touching real data.
 *
 * Usage:
 *   node scripts/test-group-unread.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { connectDB } = require('../config/db');
const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const User = require('../models/User');
const { computeUnreadCounts } = require('../controllers/groupChatController');

const TAG = `unread-test-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label} (got ${actual})`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — expected ${expected}, got ${actual}`);
  }
}

/** Count for one user in one room, through the real production helper. */
async function unreadFor(userId, roomId) {
  const room = await GroupRoom.findById(roomId);
  const counts = await computeUnreadCounts(userId, [room]);
  return counts.get(String(roomId)) || 0;
}

async function main() {
  await connectDB();

  let reader;
  let sender;
  let latecomer;
  let room;

  try {
    // ── Fixtures ────────────────────────────────────────────────────────────
    // phone is required + unique on User, so each gets a tagged unique value.
    const base = { role: 'agent', isActive: true, isVerified: true };
    reader = await User.create({ ...base, name: `${TAG}-reader`, phone: `9${Date.now()}`.slice(0, 10) });
    sender = await User.create({ ...base, name: `${TAG}-sender`, phone: `8${Date.now()}`.slice(0, 10) });
    latecomer = await User.create({ ...base, name: `${TAG}-late`, phone: `7${Date.now()}`.slice(0, 10) });

    const joinedAt = new Date(Date.now() - 60 * 60 * 1000); // an hour ago
    room = await GroupRoom.create({
      name: `${TAG}-room`,
      roomType: 'area',
      area: { city: 'Nagpur', location: 'Besa' },
      createdBy: sender._id,
      members: [
        { user: reader._id, role: 'member', joinedAt, lastReadAt: null },
        { user: sender._id, role: 'admin', joinedAt, lastReadAt: null }
      ],
      active: true
    });

    console.log(`\nRoom ${room._id} created\n`);

    // ── 1. Baseline: nothing posted yet ─────────────────────────────────────
    check('empty room has no unread', await unreadFor(reader._id, room._id), 0);

    // ── 2. A message from another member is unread ──────────────────────────
    await GroupMessage.create({
      room: room._id, sender: sender._id, messageType: 'text', content: 'hello'
    });
    check('one message from another member', await unreadFor(reader._id, room._id), 1);

    // ── 3. Own messages and system messages are ignored ─────────────────────
    await GroupMessage.create({
      room: room._id, sender: reader._id, messageType: 'text', content: 'my own reply'
    });
    await GroupMessage.create({
      room: room._id, sender: sender._id, messageType: 'system', content: 'someone joined'
    });
    check('own + system messages excluded', await unreadFor(reader._id, room._id), 1);

    // The sender should see the reader's reply as unread — proves the exclusion
    // is per-user and not a blanket filter.
    check('sender sees the reply as unread', await unreadFor(sender._id, room._id), 1);

    // ── 4. Marking read clears the count ────────────────────────────────────
    // Same update the POST /rooms/:roomId/read handler performs.
    await GroupRoom.updateOne(
      { _id: room._id, active: true, 'members.user': reader._id },
      { $set: { 'members.$.lastReadAt': new Date() } }
    );
    check('after marking read', await unreadFor(reader._id, room._id), 0);

    // ── 5. A message after reading is unread again ──────────────────────────
    await GroupMessage.create({
      room: room._id, sender: sender._id, messageType: 'text', content: 'later message'
    });
    check('new message after read', await unreadFor(reader._id, room._id), 1);

    // ── 6. A late joiner does not inherit history ───────────────────────────
    // joinedAt = now, lastReadAt absent, so the joinedAt fallback must apply.
    await GroupRoom.updateOne(
      { _id: room._id },
      { $push: { members: { user: latecomer._id, role: 'member', joinedAt: new Date(), lastReadAt: null } } }
    );
    check('late joiner sees no history', await unreadFor(latecomer._id, room._id), 0);

    await GroupMessage.create({
      room: room._id, sender: sender._id, messageType: 'text', content: 'after the late join'
    });
    check('late joiner sees only new messages', await unreadFor(latecomer._id, room._id), 1);

    // ── 7. Deleted messages are ignored ─────────────────────────────────────
    await GroupMessage.create({
      room: room._id, sender: sender._id, messageType: 'text', content: 'removed', deleted: true
    });
    check('deleted messages excluded', await unreadFor(latecomer._id, room._id), 1);
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────────────────
    if (room) {
      await GroupMessage.deleteMany({ room: room._id });
      await GroupRoom.deleteOne({ _id: room._id });
    }
    const ids = [reader?._id, sender?._id, latecomer?._id].filter(Boolean);
    if (ids.length) await User.deleteMany({ _id: { $in: ids } });
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
