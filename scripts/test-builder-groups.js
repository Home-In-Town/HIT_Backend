/**
 * Test: builder groups + media publish rights
 *
 * Two parts:
 *
 * 1. canPublishMedia() — pure permission logic, no DB. This decides who may put
 *    photos into a group and (via deleteMessage) who may take them out, so each
 *    branch is asserted explicitly, including the negative cases.
 *
 * 2. ensureBuilderGroup() — against the real database, using throwaway users:
 *    creation, idempotency, the company-name fallback, name re-sync when a
 *    company name is added later, and the role gate.
 *
 * Cleans up everything it creates.
 *
 * Usage:
 *   node scripts/test-builder-groups.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { connectDB } = require('../config/db');
const GroupRoom = require('../models/GroupRoom');
const User = require('../models/User');
const { canPublishMedia } = require('../controllers/groupChatController');
const { ensureBuilderGroup, builderGroupName } = require('../services/UniversalGroupService');

const TAG = `builder-group-test-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function permissionTests() {
  console.log('\ncanPublishMedia()');

  const builderId = new mongoose.Types.ObjectId();
  const strangerId = new mongoose.Types.ObjectId();

  const builder = { _id: builderId, role: 'builder' };
  const stranger = { _id: strangerId, role: 'builder' };
  const agent = { _id: strangerId, role: 'agent' };
  const admin = { _id: strangerId, role: 'admin' };
  const captain = { _id: strangerId, role: 'captain' };

  const ownBuilderRoom = { _id: 'r1', builder: builderId, project: null };
  const ownProjectRoom = { _id: 'r2', builder: null, project: { owner: builderId } };
  const areaRoom = { _id: 'r3', builder: null, project: null };

  check('admin anywhere', canPublishMedia(areaRoom, admin), true);
  check('captain anywhere', canPublishMedia(areaRoom, captain), true);

  check('builder in own company group', canPublishMedia(ownBuilderRoom, builder), true);
  check('builder in own property group', canPublishMedia(ownProjectRoom, builder), true);

  check('builder in someone else company group', canPublishMedia(ownBuilderRoom, stranger), false);
  check('builder in someone else property group', canPublishMedia(ownProjectRoom, stranger), false);
  check('builder in an area group', canPublishMedia(areaRoom, builder), false);
  check('plain agent in an area group', canPublishMedia(areaRoom, agent), false);

  // Populated shapes must behave identically to raw ids.
  const populatedBuilderRoom = { _id: 'r4', builder: { _id: builderId }, project: null };
  const populatedProjectRoom = { _id: 'r5', builder: null, project: { owner: { _id: builderId } } };
  check('populated builder ref', canPublishMedia(populatedBuilderRoom, builder), true);
  check('populated project owner ref', canPublishMedia(populatedProjectRoom, builder), true);

  check('missing room', canPublishMedia(null, admin), false);
  check('missing user', canPublishMedia(areaRoom, null), false);
}

async function serviceTests() {
  console.log('\nensureBuilderGroup()');

  const created = [];
  let withCompany;
  let noCompany;
  let plainUser;

  try {
    withCompany = await User.create({
      name: `${TAG}-person`,
      companyName: `${TAG} Developers`,
      phone: `5${Date.now()}`.slice(0, 10),
      role: 'builder',
      isActive: true
    });
    noCompany = await User.create({
      name: `${TAG}-solo`,
      phone: `4${Date.now()}`.slice(0, 10),
      role: 'builder',
      isActive: true
    });
    plainUser = await User.create({
      name: `${TAG}-plain`,
      phone: `3${Date.now()}`.slice(0, 10),
      role: 'user',
      isActive: true
    });

    // ── Creation + naming ───────────────────────────────────────────────────
    const first = await ensureBuilderGroup(withCompany, null);
    check('creates a group', !!first?.room, true);
    check('marked new', first?.isNew, true);
    check('named after the company', first?.room?.name, `${TAG} Developers`);
    check('roomType is builder', first?.room?.roomType, 'builder');
    check('builder is a member', (first?.room?.members || []).length, 1);
    if (first?.room) created.push(first.room._id);

    // ── Idempotency ─────────────────────────────────────────────────────────
    const second = await ensureBuilderGroup(withCompany, null);
    check('second call reuses the group', String(second?.room?._id), String(first?.room?._id));
    check('second call is not new', second?.isNew, false);

    const count = await GroupRoom.countDocuments({
      builder: withCompany._id, roomType: 'builder', active: true
    });
    check('exactly one active group', count, 1);

    // ── Name fallback when there is no company ──────────────────────────────
    const solo = await ensureBuilderGroup(noCompany, null);
    check('falls back to the person name', solo?.room?.name, `${TAG}-solo`);
    if (solo?.room) created.push(solo.room._id);

    // ── Name re-sync after a company name is added ──────────────────────────
    await User.updateOne({ _id: noCompany._id }, { $set: { companyName: `${TAG} Late Co` } });
    const renamed = await ensureBuilderGroup(noCompany._id, null);
    check('renames when a company is added', renamed?.room?.name, `${TAG} Late Co`);
    check('rename reuses the same group', String(renamed?.room?._id), String(solo?.room?._id));

    // ── Role gate ───────────────────────────────────────────────────────────
    const rejected = await ensureBuilderGroup(plainUser, null);
    check('plain user gets no group', rejected, null);

    // ── Accepts an id as well as a document ─────────────────────────────────
    const byId = await ensureBuilderGroup(String(withCompany._id), null);
    check('accepts a raw id', String(byId?.room?._id), String(first?.room?._id));

    // ── builderGroupName edge cases ─────────────────────────────────────────
    check('trims the company name', builderGroupName({ companyName: '  Acme  ', name: 'X' }), 'Acme');
    check('ignores an empty company', builderGroupName({ companyName: '   ', name: 'Ravi' }), 'Ravi');
    check('handles a nameless user', builderGroupName({}), 'Builder');
  } finally {
    if (created.length) await GroupRoom.deleteMany({ _id: { $in: created } });
    const ids = [withCompany?._id, noCompany?._id, plainUser?._id].filter(Boolean);
    if (ids.length) await User.deleteMany({ _id: { $in: ids } });
    console.log('\nCleanup done');
  }
}

async function main() {
  permissionTests();

  await connectDB();
  try {
    await serviceTests();
  } finally {
    await mongoose.connection.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
