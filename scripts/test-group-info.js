/**
 * Test: group info — member phone privacy, builder project count, room media
 *
 * Covers the three server-side halves of the group-info feature:
 *
 * 1. sanitizeRoom() — pure, no DB. Member phone numbers must survive in builder
 *    and project rooms (their member list IS a contact list) and must be gone in
 *    universal and area rooms. The universal room holds every user on the
 *    platform, so a leak there hands every user's number to every other user.
 *    This is asserted on the payload, not on the UI, because hiding the number in
 *    the mobile component would still ship it over the wire.
 *
 * 2. getRooms() — against the real database, through the actual handler, with a
 *    throwaway builder who has two published projects and one draft: the builder
 *    room must report projectCount 2, and the same response must carry phone for
 *    the builder/project rooms and none for the universal/area rooms.
 *
 * 3. getRoomMedia() — membership gate (403 for a non-member), only image/file and
 *    link-bearing text messages, soft-deleted messages excluded, the limit
 *    clamped, and the sender's phone stripped.
 *
 * The throwaway "universal" room is created with `isUniversal: false` on purpose:
 * UniversalGroupService finds the real community room by `isUniversal: true`, so
 * this room is invisible to it and no real user can be auto-joined to it during
 * the run. sanitizeRoom keys off `roomType`, which is what is under test.
 *
 * Cleans up everything it creates.
 *
 * Usage:
 *   node scripts/test-group-info.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { connectDB } = require('../config/db');
const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const Project = require('../models/Project');
const User = require('../models/User');
const { sanitizeRoom, getRooms, getRoomMedia } = require('../controllers/groupChatController');

const TAG = `group-info-test-${Date.now()}`;

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

/** Minimal Express res stand-in so the real handlers can be called directly. */
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

/** Phone of the first member of a room payload, or undefined. */
function firstMemberPhone(room) {
  return room?.members?.[0]?.user?.phone;
}

// ═══════════════════════════════════════════════════════════
// 1. sanitizeRoom() — pure
// ═══════════════════════════════════════════════════════════

function sanitizeTests() {
  console.log('\nsanitizeRoom()');

  const member = () => ({ user: { _id: 'u1', name: 'Ravi', role: 'agent', phone: '9876500000' }, role: 'member' });
  const roomOfType = (roomType) => ({ _id: 'r', roomType, members: [member()] });

  check('builder room keeps phone', firstMemberPhone(sanitizeRoom(roomOfType('builder'))), '9876500000');
  check('project room keeps phone', firstMemberPhone(sanitizeRoom(roomOfType('project'))), '9876500000');
  check('universal room drops phone', firstMemberPhone(sanitizeRoom(roomOfType('universal'))), undefined);
  check('area room drops phone', firstMemberPhone(sanitizeRoom(roomOfType('area'))), undefined);

  // Everything else about the member row must survive the strip.
  const stripped = sanitizeRoom(roomOfType('universal'));
  check('universal room keeps the member name', stripped.members[0].user.name, 'Ravi');
  check('universal room keeps the member role', stripped.members[0].role, 'member');

  // An unknown / missing roomType must fail CLOSED, not open.
  check('unknown roomType drops phone', firstMemberPhone(sanitizeRoom({ _id: 'r', members: [member()] })), undefined);

  // The discover list does not populate members, so `user` is a raw id there.
  const rawRefs = sanitizeRoom({ _id: 'r', roomType: 'universal', members: [{ user: 'rawObjectId', role: 'member' }] });
  check('raw member ref survives untouched', rawRefs.members[0].user, 'rawObjectId');
  check('empty members list is fine', sanitizeRoom({ _id: 'r', roomType: 'universal' }).members, undefined);
  check('null room passes through', sanitizeRoom(null), null);

  // toObject() must be used when present, and the source document left alone —
  // otherwise the strip would mutate mongoose's cached document and the phone
  // would vanish for a later builder-room response in the same request.
  const doc = { roomType: 'universal', members: [member()] };
  const asDocument = { toObject: () => JSON.parse(JSON.stringify(doc)) };
  check('document path drops phone', firstMemberPhone(sanitizeRoom(asDocument)), undefined);
  check('source document untouched', doc.members[0].user.phone, '9876500000');
}

// ═══════════════════════════════════════════════════════════
// 2 + 3. getRooms() / getRoomMedia() — against the database
// ═══════════════════════════════════════════════════════════

async function handlerTests() {
  const created = { users: [], projects: [], rooms: [], messages: [] };

  let builder;
  let member;
  let stranger;

  try {
    const phone = (prefix) => `${prefix}${Date.now()}`.slice(0, 10);

    builder = await User.create({
      name: `${TAG}-builder`,
      companyName: `${TAG} Developers`,
      phone: phone('7'),
      role: 'builder',
      isActive: true
    });
    member = await User.create({
      name: `${TAG}-member`,
      phone: phone('8'),
      role: 'agent',
      isActive: true
    });
    stranger = await User.create({
      name: `${TAG}-stranger`,
      phone: phone('6'),
      role: 'agent',
      isActive: true
    });
    created.users.push(builder._id, member._id, stranger._id);

    // Two published + one draft. The draft must NOT be counted.
    const published1 = await Project.create({ projectName: `${TAG}-p1`, owner: builder._id, status: 'published' });
    const published2 = await Project.create({ projectName: `${TAG}-p2`, owner: builder._id, status: 'published' });
    const draft = await Project.create({ projectName: `${TAG}-draft`, owner: builder._id, status: 'draft' });
    created.projects.push(published1._id, published2._id, draft._id);

    const members = [
      { user: builder._id, role: 'admin' },
      { user: member._id, role: 'member' }
    ];

    const builderRoom = await GroupRoom.create({
      name: `${TAG} Developers`, roomType: 'builder', builder: builder._id, createdBy: builder._id, members
    });
    const projectRoom = await GroupRoom.create({
      name: `${TAG}-p1`, roomType: 'project', project: published1._id, createdBy: builder._id, members
    });
    const areaRoom = await GroupRoom.create({
      name: `${TAG}-area`, roomType: 'area', area: { city: 'Nagpur', location: 'Manish Nagar' }, createdBy: builder._id, members
    });
    const universalRoom = await GroupRoom.create({
      // isUniversal stays false — see the header comment.
      name: `${TAG}-universal`, roomType: 'universal', createdBy: builder._id, members, canLeave: false
    });
    created.rooms.push(builderRoom._id, projectRoom._id, areaRoom._id, universalRoom._id);

    // ── getRooms(): phone privacy + projectCount ───────────────────────────
    console.log('\ngetRooms()');

    const res = fakeRes();
    await getRooms({ user: { _id: member._id }, query: {} }, res);
    check('responds 200', res.statusCode, 200);

    const byId = new Map((res.body?.myRooms || []).map(r => [String(r._id), r]));
    const got = (room) => byId.get(String(room._id));

    check('builder room returned', !!got(builderRoom), true);
    check('project room returned', !!got(projectRoom), true);
    check('area room returned', !!got(areaRoom), true);
    check('universal room returned', !!got(universalRoom), true);

    // The payload itself is what matters — this is the hard requirement.
    check('builder room ships phone', firstMemberPhone(got(builderRoom)), builder.phone);
    check('project room ships phone', firstMemberPhone(got(projectRoom)), builder.phone);
    check('universal room ships NO phone', firstMemberPhone(got(universalRoom)), undefined);
    check('area room ships NO phone', firstMemberPhone(got(areaRoom)), undefined);

    // Every member, not just the first — a per-index bug would pass the above.
    const universalPhones = (got(universalRoom)?.members || []).filter(m => m?.user?.phone).length;
    check('no universal member has a phone', universalPhones, 0);
    const builderPhones = (got(builderRoom)?.members || []).filter(m => m?.user?.phone).length;
    check('every builder member has a phone', builderPhones, 2);

    // A JSON round-trip is what actually goes over the wire.
    check('phone absent from serialised universal room',
      JSON.stringify(got(universalRoom)).includes(builder.phone), false);

    check('builder room projectCount excludes the draft', got(builderRoom)?.projectCount, 2);
    check('project room has no projectCount', got(projectRoom)?.projectCount, undefined);
    check('area room has no projectCount', got(areaRoom)?.projectCount, undefined);

    // Discover list: the builder has a published project, so their company group
    // stays discoverable now that the gate is derived from the aggregation rather
    // than from the deleted Project.distinct() call.
    const strangerRes = fakeRes();
    await getRooms({ user: { _id: stranger._id }, query: { search: TAG } }, strangerRes);
    const discoverIds = new Set((strangerRes.body?.discoverRooms || []).map(r => String(r._id)));
    check('published builder stays discoverable', discoverIds.has(String(builderRoom._id)), true);
    check('discover builder row carries projectCount',
      (strangerRes.body?.discoverRooms || []).find(r => String(r._id) === String(builderRoom._id))?.projectCount, 2);

    // Same gate for a builder whose only project is a draft — the behaviour the
    // removed distinct() used to provide.
    const draftOnlyBuilder = await User.create({
      name: `${TAG}-draftonly`, companyName: `${TAG} Draft Co`, phone: phone('5'), role: 'builder', isActive: true
    });
    created.users.push(draftOnlyBuilder._id);
    const draftOnlyProject = await Project.create({
      projectName: `${TAG}-draftonly-p`, owner: draftOnlyBuilder._id, status: 'draft'
    });
    created.projects.push(draftOnlyProject._id);
    const draftOnlyRoom = await GroupRoom.create({
      name: `${TAG} Draft Co`, roomType: 'builder', builder: draftOnlyBuilder._id, createdBy: draftOnlyBuilder._id,
      members: [{ user: draftOnlyBuilder._id, role: 'admin' }]
    });
    created.rooms.push(draftOnlyRoom._id);

    const draftRes = fakeRes();
    await getRooms({ user: { _id: stranger._id }, query: { search: TAG } }, draftRes);
    const draftDiscoverIds = new Set((draftRes.body?.discoverRooms || []).map(r => String(r._id)));
    check('draft-only builder stays hidden', draftDiscoverIds.has(String(draftOnlyRoom._id)), false);

    // ── getRoomMedia() ─────────────────────────────────────────────────────
    console.log('\ngetRoomMedia()');

    const msgs = await GroupMessage.insertMany([
      { room: builderRoom._id, sender: builder._id, messageType: 'image', content: 'https://cdn.example/a.jpg', attachment: { name: 'a.jpg', mimeType: 'image/jpeg', size: 10 } },
      { room: builderRoom._id, sender: builder._id, messageType: 'image', content: 'https://cdn.example/b.jpg', attachment: { name: 'b.jpg', mimeType: 'image/jpeg', size: 20 } },
      { room: builderRoom._id, sender: builder._id, messageType: 'file', content: 'https://cdn.example/c.pdf', attachment: { name: 'c.pdf', mimeType: 'application/pdf', size: 30 } },
      { room: builderRoom._id, sender: builder._id, messageType: 'image', content: 'https://cdn.example/gone.jpg', deleted: true },
      { room: builderRoom._id, sender: member._id, messageType: 'text', content: 'See https://homeintown.in/p/abc for details' },
      { room: builderRoom._id, sender: member._id, messageType: 'text', content: 'no link in this one' },
      { room: builderRoom._id, sender: member._id, messageType: 'system', content: 'joined the group' }
    ]);
    created.messages.push(...msgs.map(m => m._id));

    const mediaRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(builderRoom._id) }, user: { _id: member._id }, query: {} }, mediaRes);
    check('member gets 200', mediaRes.statusCode, 200);
    check('three media messages', mediaRes.body?.media?.length, 3);
    check('soft-deleted media excluded',
      (mediaRes.body?.media || []).some(m => String(m.content).includes('gone.jpg')), false);
    check('one link message', mediaRes.body?.links?.length, 1);
    check('link-free text excluded',
      (mediaRes.body?.links || []).some(m => m.content === 'no link in this one'), false);
    check('system message excluded',
      [...(mediaRes.body?.media || []), ...(mediaRes.body?.links || [])].some(m => m.messageType === 'system'), false);
    check('default page', mediaRes.body?.page, 1);
    check('default limit', mediaRes.body?.limit, 30);

    // Media is not an inventory card, so sanitizeMessage() must have removed the
    // poster's number — the group-info sheet never needs it.
    check('media sender phone stripped',
      (mediaRes.body?.media || []).some(m => m.sender?.phone), false);
    check('link sender phone stripped',
      (mediaRes.body?.links || []).some(m => m.sender?.phone), false);

    // Membership gate: a non-member must get nothing at all.
    const forbiddenRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(builderRoom._id) }, user: { _id: stranger._id }, query: {} }, forbiddenRes);
    check('non-member gets 403', forbiddenRes.statusCode, 403);
    check('non-member gets no media', forbiddenRes.body?.media, undefined);

    // Deactivated rooms are not readable either.
    await GroupRoom.updateOne({ _id: areaRoom._id }, { $set: { active: false } });
    const inactiveRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(areaRoom._id) }, user: { _id: member._id }, query: {} }, inactiveRes);
    check('inactive room gets 403', inactiveRes.statusCode, 403);
    await GroupRoom.updateOne({ _id: areaRoom._id }, { $set: { active: true } });

    const badIdRes = fakeRes();
    await getRoomMedia({ params: { roomId: 'not-an-objectid' }, user: { _id: member._id }, query: {} }, badIdRes);
    check('invalid roomId gets 400', badIdRes.statusCode, 400);

    // Bounding: an oversized limit must be clamped, never honoured.
    const hugeRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(builderRoom._id) }, user: { _id: member._id }, query: { limit: '100000' } }, hugeRes);
    check('oversized limit clamped to 60', hugeRes.body?.limit, 60);

    const pagedRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(builderRoom._id) }, user: { _id: member._id }, query: { limit: '2', page: '2' } }, pagedRes);
    check('page 2 of 2 returns the third media', pagedRes.body?.media?.length, 1);
    check('page echoed back', pagedRes.body?.page, 2);

    const zeroPageRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(builderRoom._id) }, user: { _id: member._id }, query: { page: '0' } }, zeroPageRes);
    check('page 0 floors to 1 (no negative skip)', zeroPageRes.body?.page, 1);

    const negLimitRes = fakeRes();
    await getRoomMedia({ params: { roomId: String(builderRoom._id) }, user: { _id: member._id }, query: { limit: '-5' } }, negLimitRes);
    check('negative limit floors to 1', negLimitRes.body?.limit, 1);
    check('negative limit returns one row', negLimitRes.body?.media?.length, 1);
  } finally {
    if (created.messages.length) await GroupMessage.deleteMany({ _id: { $in: created.messages } });
    if (created.rooms.length) await GroupRoom.deleteMany({ _id: { $in: created.rooms } });
    if (created.projects.length) await Project.deleteMany({ _id: { $in: created.projects } });
    if (created.users.length) await User.deleteMany({ _id: { $in: created.users } });
    console.log('\nCleanup done');
  }
}

async function main() {
  sanitizeTests();

  await connectDB();
  try {
    await handlerTests();
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
