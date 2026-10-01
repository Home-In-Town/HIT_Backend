const mongoose = require('mongoose');
const crypto = require('crypto');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { r2 } = require('../config/r2');
const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const DealRoom = require('../models/DealRoom');
const ChatSession = require('../models/ChatSession');
const Notification = require('../models/Notification');
const Project = require('../models/Project');
const User = require('../models/User');
const matchEngine = require('../services/MatchEngine');
const leadCaptureService = require('../services/LeadCaptureService');
const { ensureProjectGroup } = require('../services/UniversalGroupService');

// Project fields needed to render a full property card on a group.
const ROOM_PROJECT_FIELDS = 'projectName projectType category propertyType city location latitude longitude googleMapLink reraApproved reraNumber projectStatus pricing configuration amenities media slug status owner';

/**
 * Room's project WITH the owner resolved.
 *
 * Selecting `owner` alone only yields an ObjectId, so the client had no company
 * name to show — the Groups list is organised by company, so the nested populate
 * is required, not cosmetic.
 */
const ROOM_PROJECT_POPULATE = {
  path: 'project',
  select: ROOM_PROJECT_FIELDS,
  populate: { path: 'owner', select: 'name companyName role isVerified verificationStatus' }
};

// Builder rooms are company-level groups; the client shows the company name and
// verification state on the row.
const ROOM_BUILDER_FIELDS = 'name companyName role isVerified verificationStatus';

/**
 * Member fields sent to clients for a room's member list.
 *
 * `phone` is selected here but is NOT unconditionally shipped: every room-bearing
 * response goes through sanitizeRoom(), which deletes it for every room type
 * except builder and project. Selecting it once in a shared constant is what
 * makes that possible — the previous code repeated the literal
 * `'name role companyName'` at seven call sites, so any per-room-type rule would
 * have had to be re-implemented (and sooner or later forgotten) at each of them.
 */
const ROOM_MEMBER_FIELDS = 'name role companyName phone';

/**
 * Room types whose member list is a legitimate contact list.
 *
 * A builder group is a company's showcase and a project group is the people
 * transacting on one property — in both, members expect to be reachable. The
 * universal room contains EVERY user on the platform, so shipping phone numbers
 * there would hand every user's number to every other user; area rooms are not
 * builder showcases either, so they get the same treatment.
 */
const PHONE_VISIBLE_ROOM_TYPES = new Set(['builder', 'project']);

/**
 * Strips member phone numbers from a room payload unless the room type is one
 * where the member list is meant to be a contact list.
 *
 * This runs on the SERVER, deliberately. Hiding the number in the mobile
 * component would still serialise every universal-room member's phone over the
 * wire, where anyone with the auth token and a proxy can read it — that is not a
 * fix, it is a cosmetic change. Modelled on sanitizeMessage() above, which
 * exists for the same reason on the message path.
 *
 * Returns a plain object; mongoose documents are converted so the delete cannot
 * touch the cached document.
 *
 * Exported for the test script — not a route handler.
 *
 * @param {Object} room GroupRoom document or plain object (may be null)
 */
function sanitizeRoom(room) {
  if (!room) return room;
  const obj = typeof room.toObject === 'function' ? room.toObject() : room;
  if (PHONE_VISIBLE_ROOM_TYPES.has(obj.roomType)) return obj;

  for (const member of obj.members || []) {
    // The discover list does not populate members, so `user` is still an
    // ObjectId there — nothing to strip, and `delete` on it would be wrong.
    if (member?.user && typeof member.user === 'object') delete member.user.phone;
  }
  return obj;
}

exports.sanitizeRoom = sanitizeRoom;

// Roles allowed to put photos / PDFs into ANY group. Ordinary members can read
// media but not publish it, so a group's media stays curated.
const MEDIA_UPLOAD_ROLES = ['admin', 'captain'];

/**
 * May this user publish (or remove) media in this room?
 *
 * Admins and captains may do so anywhere. Beyond that, a builder owns the media
 * in their OWN rooms — their company group and the groups of properties they
 * own — because that is their showcase. Nobody else can publish media.
 *
 * @param {Object} room GroupRoom doc/lean with `builder` and `project.owner`
 *                      available (populated or raw ids)
 * @param {Object} user req.user
 */
function canPublishMedia(room, user) {
  if (!room || !user) return false;
  if (MEDIA_UPLOAD_ROLES.includes(user.role)) return true;

  const userId = String(user._id);

  // Their own company group.
  const builderId = String(room.builder?._id || room.builder || '');
  if (builderId && builderId === userId) return true;

  // A property group for a property they own.
  const ownerId = String(room.project?.owner?._id || room.project?.owner || '');
  if (ownerId && ownerId === userId) return true;

  return false;
}

// Exported for the test script — not a route handler.
exports.canPublishMedia = canPublishMedia;

// Sender fields sent to clients. `phone` is included so an inventory card can
// offer a direct call to whoever posted the property.
const MESSAGE_SENDER_FIELDS = 'name role companyName isVerified verificationStatus phone';

/**
 * Only inventory cards need the poster's phone number (the card's Call button
 * dials it). Every other message type gets it stripped, so opening a group does
 * not hand out the phone number of everyone who ever typed in it.
 */
function sanitizeMessage(doc) {
  const obj = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  if (obj?.sender && typeof obj.sender === 'object' && obj.messageType !== 'inventory_card') {
    delete obj.sender.phone;
  }
  return obj;
}

/**
 * Unread message count per room for one user.
 *
 * Deliberately ONE aggregation for every room rather than a count per room: the
 * room list routinely holds dozens of groups, and a per-room query would make
 * opening the Groups tab an N+1.
 *
 * The cutoff for each room is that member's `lastReadAt`, falling back to their
 * `joinedAt`. The fallback is what stops members who joined before read tracking
 * existed from seeing a group's entire history as unread, and it also means a
 * newly joined member never inherits messages sent before they arrived.
 *
 * System messages ("X joined the group") and the user's own messages never count.
 *
 * Exported for the test script — it is not a route handler.
 *
 * @param {ObjectId} userId
 * @param {Array} rooms GroupRoom documents the user is a member of
 * @returns {Promise<Map<string, number>>} roomId string → unread count
 */
async function computeUnreadCounts(userId, rooms) {
  const counts = new Map();
  if (!Array.isArray(rooms) || rooms.length === 0) return counts;

  const conditions = [];
  for (const room of rooms) {
    const membership = (room.members || []).find(m => {
      const memberId = m?.user?._id || m?.user;
      return String(memberId) === String(userId);
    });
    // `createdAt` is the last resort for a room whose membership row somehow has
    // neither marker; it keeps the count finite instead of unbounded.
    const since = membership?.lastReadAt || membership?.joinedAt || room.createdAt;
    if (!since) continue;
    conditions.push({ room: room._id, createdAt: { $gt: since } });
  }

  // An empty $or is a Mongo error, so bail out before querying.
  if (conditions.length === 0) return counts;

  // Matches the { room: 1, createdAt: -1 } index on GroupMessage.
  const rows = await GroupMessage.aggregate([
    {
      $match: {
        deleted: false,
        messageType: { $ne: 'system' },
        sender: { $ne: userId },
        $or: conditions
      }
    },
    { $group: { _id: '$room', count: { $sum: 1 } } }
  ]);

  for (const row of rows) counts.set(String(row._id), row.count);
  return counts;
}

exports.computeUnreadCounts = computeUnreadCounts;

/**
 * Project fields a match card needs, with the builder deep-populated.
 *
 * `owner` alone only yields an ObjectId — the match card shows the builder's
 * NAME, so the nested populate is required, not cosmetic.
 */
const MATCH_PROJECT_POPULATE = {
  path: 'matchResults.project',
  select: 'projectName city location pricing configuration owner slug media',
  populate: { path: 'owner', select: 'name companyName isVerified verificationStatus' }
};

/**
 * Attaches each match's property GROUP to the message payload.
 *
 * A matching result advertises the property's group — its name, how many members
 * it has and how recently it was active — because the card's primary action is
 * "Join Group". Match results only carry the Project, so the group has to be
 * looked up.
 *
 * Done in ONE query for every match across the whole page. A lookup per card
 * would be an N+1 on a thread that can hold many requirement cards.
 *
 * Mutates and returns plain objects, so call it AFTER sanitizeMessage().
 */
async function attachMatchGroups(payload) {
  const list = Array.isArray(payload) ? payload : [payload];

  const projectIds = [];
  for (const msg of list) {
    for (const match of msg?.matchResults || []) {
      const pid = match?.project?._id || match?.project;
      if (pid) projectIds.push(pid);
    }
  }
  if (projectIds.length === 0) return payload;

  const rooms = await GroupRoom.find({
    project: { $in: projectIds },
    roomType: 'project',
    active: true
  }).select('_id name project members lastActivity').lean();

  const byProject = new Map(rooms.map(room => [String(room.project), room]));

  for (const msg of list) {
    for (const match of msg?.matchResults || []) {
      const pid = String(match?.project?._id || match?.project || '');
      const room = byProject.get(pid);
      // null (not undefined) so the client can tell "no group for this property"
      // apart from "the server didn't send group data".
      match.group = room
        ? {
          id: room._id,
          name: room.name,
          membersCount: (room.members || []).length,
          lastActivity: room.lastActivity
        }
        : null;
    }
  }

  return payload;
}

// Exported for the test script — not a route handler.
exports.attachMatchGroups = attachMatchGroups;

// ═══════════════════════════════════════════════════════════
// GROUP ROOMS
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/group-chat/rooms
 * Create a new group room (project-wise or area-wise)
 */
exports.createRoom = async (req, res) => {
  try {
    const { name, roomType, projectId, area, description } = req.body;
    const userId = req.user._id;

    if (!name || !roomType) {
      return res.status(400).json({ error: 'name and roomType are required' });
    }

    if (roomType === 'project' && !projectId) {
      return res.status(400).json({ error: 'projectId is required for project rooms' });
    }
    if (roomType === 'area' && (!area?.city || !area?.location)) {
      return res.status(400).json({ error: 'area.city and area.location are required for area rooms' });
    }

    // ── Project rooms ──────────────────────────────────────────────────────
    // This endpoint used to accept ANY projectId with no existence check and no
    // ownership check, making the caller admin of another builder's property
    // group. Now the project must exist, the caller must be allowed to manage
    // it, and creation is delegated to the single canonical code path so a
    // manual create can never produce a second group for the same project.
    if (roomType === 'project') {
      if (!mongoose.Types.ObjectId.isValid(String(projectId))) {
        return res.status(400).json({ error: 'Invalid projectId' });
      }

      const project = await Project.findById(projectId).select('owner coCaptains projectName').lean();
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const ownerId = project.owner ? project.owner.toString() : '';
      const coCaptainIds = (project.coCaptains || []).map(c => c.toString());
      const isOwner = ownerId === userId.toString();
      const isCoCaptain = coCaptainIds.includes(userId.toString());

      if (!isOwner && !isCoCaptain && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only the project owner or an admin can create this property group' });
      }

      const existing = await GroupRoom.findOne({ project: projectId, roomType: 'project', active: true });
      if (existing) {
        await existing.populate('members.user', ROOM_MEMBER_FIELDS);
        await existing.populate(ROOM_PROJECT_POPULATE);
        return res.status(409).json({ error: 'A group already exists for this property', room: sanitizeRoom(existing) });
      }

      const ensured = await ensureProjectGroup(projectId, req.app.get('io'));
      if (!ensured) {
        return res.status(500).json({ error: 'Could not create the property group' });
      }

      const room = ensured.room;
      await room.populate('members.user', ROOM_MEMBER_FIELDS);
      await room.populate(ROOM_PROJECT_POPULATE);
      return res.status(201).json({ room: sanitizeRoom(room) });
    }

    const room = await GroupRoom.create({
      name,
      roomType,
      project: null,
      area: roomType === 'area' ? area : undefined,
      createdBy: userId,
      description: description || '',
      members: [{ user: userId, role: 'admin' }],
      lastActivity: new Date()
    });

    await room.populate('members.user', ROOM_MEMBER_FIELDS);

    res.status(201).json({ room: sanitizeRoom(room) });
  } catch (err) {
    // Unique index on active project rooms — someone created it concurrently.
    if (err?.code === 11000) {
      const existing = await GroupRoom.findOne({ project: req.body.projectId, roomType: 'project', active: true })
        .populate('members.user', ROOM_MEMBER_FIELDS)
        .populate(ROOM_PROJECT_POPULATE);
      return res.status(409).json({ error: 'A group already exists for this property', room: sanitizeRoom(existing) });
    }
    if (err?.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    console.error('createRoom error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/group-chat/rooms
 * Get all rooms the user is a member of + discoverable rooms
 */
exports.getRooms = async (req, res) => {
  try {
    const userId = req.user._id;
    const { type, search } = req.query;

    const filter = { active: true };
    if (type) filter.roomType = type;

    // Get rooms user is a member of
    const myRooms = await GroupRoom.find({
      ...filter,
      'members.user': userId
    })
      .populate(ROOM_PROJECT_POPULATE)
      .populate('builder', ROOM_BUILDER_FIELDS)
      .populate('members.user', ROOM_MEMBER_FIELDS)
      .populate('createdBy', 'name')
      .sort({ lastActivity: -1 });

    // ── Discoverable rooms ─────────────────────────────────────────────────
    // Rooms the user has NOT joined. The membership filter already guarantees
    // no overlap with myRooms, so a joined group can never appear twice.
    const discoverFilter = {
      ...filter,
      'members.user': { $ne: userId },
      isUniversal: { $ne: true } // everyone is auto-joined; never "discoverable"
    };
    if (search) {
      discoverFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { 'area.city': { $regex: search, $options: 'i' } },
        { 'area.location': { $regex: search, $options: 'i' } }
      ];
    }

    // Over-fetch, then drop property groups whose project is unpublished or
    // missing. Projects now get a group at creation time, so without this a
    // draft property's details would become publicly discoverable.
    const discoverCandidates = await GroupRoom.find(discoverFilter)
      .populate(ROOM_PROJECT_POPULATE)
      .populate('builder', ROOM_BUILDER_FIELDS)
      .populate('createdBy', 'name')
      .sort({ lastActivity: -1 })
      .limit(120);

    // ── Published project count per builder ────────────────────────────────
    // Serves two purposes at once with ONE aggregation over every builder room
    // in the whole response:
    //
    //   1. The Groups list shows "N projects" on a company row, so the client
    //      needs the number, not just a boolean.
    //   2. A builder whose only properties are drafts must not become publicly
    //      discoverable — the same rule property groups already get.
    //
    // This replaces a `Project.distinct('owner', …)` that only answered (2).
    // The count is a superset of that answer (count > 0 means "has a published
    // project"), so deriving the discover gate from the aggregation keys keeps
    // the query count unchanged instead of adding one. A count query per room
    // would be an N+1 on a list that routinely holds dozens of groups — the same
    // reasoning computeUnreadCounts() documents above.
    const builderRoomIds = [...myRooms, ...discoverCandidates]
      .filter(room => room.roomType === 'builder' && room.builder)
      .map(room => room.builder._id || room.builder);

    const projectCountByBuilder = new Map();
    if (builderRoomIds.length > 0) {
      const rows = await Project.aggregate([
        { $match: { owner: { $in: builderRoomIds }, status: 'published' } },
        { $group: { _id: '$owner', count: { $sum: 1 } } }
      ]);
      for (const row of rows) projectCountByBuilder.set(String(row._id), row.count);
    }

    // A builder is discoverable exactly when the aggregation found at least one
    // published project for them — previously the answer came from distinct().
    const publishedBuilderIds = new Set(
      [...projectCountByBuilder.entries()].filter(([, count]) => count > 0).map(([id]) => id)
    );

    /**
     * Attaches `projectCount` to a builder room, leaving every other room type
     * alone: a project room is one property, so "18 projects" there would be
     * nonsense, and the client only reads the field on company rows.
     */
    const withProjectCount = (room) => {
      const obj = sanitizeRoom(room);
      if (obj?.roomType === 'builder') {
        const builderId = String(obj.builder?._id || obj.builder || '');
        obj.projectCount = projectCountByBuilder.get(builderId) || 0;
      }
      return obj;
    };

    const discoverRooms = discoverCandidates
      .filter(room => {
        if (room.roomType === 'project') {
          return !!room.project && room.project.status === 'published';
        }
        if (room.roomType === 'builder') {
          const builderId = String(room.builder?._id || room.builder || '');
          return !!builderId && publishedBuilderIds.has(builderId);
        }
        return true;
      })
      .slice(0, 50)
      // sanitizeRoom() runs here too. The discover list does not populate
      // members today, so there is nothing to strip — routing it through anyway
      // means a future `.populate('members.user', …)` added here cannot silently
      // start leaking phone numbers.
      .map(withProjectCount);

    // Unread badge data. Only joined rooms can have unread messages, so the
    // discover list is left untouched.
    const unread = await computeUnreadCounts(userId, myRooms);
    const myRoomsPayload = myRooms.map(room => ({
      // withProjectCount() already converts the document via sanitizeRoom(),
      // replacing the previous bare room.toObject().
      ...withProjectCount(room),
      unreadCount: unread.get(String(room._id)) || 0
    }));

    res.status(200).json({ myRooms: myRoomsPayload, discoverRooms });
  } catch (err) {
    console.error('getRooms error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/group-chat/rooms/:roomId/join
 * Join a group room
 */
exports.joinRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
      return res.status(400).json({ error: 'Invalid roomId' });
    }

    const room = await GroupRoom.findById(roomId);
    if (!room || !room.active) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Atomic guarded push: the "not already a member" check is in the filter, so
    // a double-tap on Join cannot add the same user twice.
    const result = await GroupRoom.updateOne(
      { _id: roomId, 'members.user': { $ne: userId } },
      {
        $push: { members: { user: userId, role: 'member', joinedAt: new Date() } },
        $set: { lastActivity: new Date() }
      }
    );
    const added = (result.modifiedCount ?? result.nModified ?? 0) > 0;

    // Always return the room fully populated so the client can render the
    // property card immediately after joining.
    const fresh = await GroupRoom.findById(roomId)
      .populate(ROOM_PROJECT_POPULATE)
      .populate('builder', ROOM_BUILDER_FIELDS)
      .populate('members.user', ROOM_MEMBER_FIELDS)
      .populate('createdBy', 'name');

    if (!added) {
      return res.status(200).json({ message: 'Already a member', room: sanitizeRoom(fresh) });
    }

    // Post system message
    await GroupMessage.create({
      room: roomId,
      sender: userId,
      messageType: 'system',
      content: `${req.user.name} joined the group`
    });

    res.status(200).json({ room: sanitizeRoom(fresh) });
  } catch (err) {
    console.error('joinRoom error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/group-chat/projects/:projectId/join
 *
 * Join (or simply open) the canonical group of a property. An inventory card in
 * the universal room only carries a projectId — never a roomId — so the client
 * has no room to join by id, and for older properties the group may not exist
 * yet. Both cases are resolved here through the single canonical creation path.
 */
exports.joinProjectRoom = async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(String(projectId))) {
      return res.status(400).json({ error: 'Invalid projectId' });
    }

    const project = await Project.findById(projectId).select('_id').lean();
    if (!project) {
      return res.status(404).json({ error: 'Property not found' });
    }

    let room = await GroupRoom.findOne({ project: projectId, roomType: 'project', active: true });
    if (!room) {
      const ensured = await ensureProjectGroup(projectId, req.app.get('io'));
      room = ensured?.room || null;
    }
    if (!room) {
      return res.status(404).json({ error: 'No group exists for this property yet' });
    }

    const alreadyMember = room.members.some(m => m.user.toString() === userId.toString());

    if (!alreadyMember) {
      // Same atomic guarded push as joinRoom, so a double-tap cannot add the
      // same member twice.
      const result = await GroupRoom.updateOne(
        { _id: room._id, 'members.user': { $ne: userId } },
        {
          $push: { members: { user: userId, role: 'member', joinedAt: new Date() } },
          $set: { lastActivity: new Date() }
        }
      );
      if ((result.modifiedCount ?? result.nModified ?? 0) > 0) {
        await GroupMessage.create({
          room: room._id,
          sender: userId,
          messageType: 'system',
          content: `${req.user.name} joined the group`
        });
      }
    }

    const fresh = await GroupRoom.findById(room._id)
      .populate(ROOM_PROJECT_POPULATE)
      .populate('builder', ROOM_BUILDER_FIELDS)
      .populate('members.user', ROOM_MEMBER_FIELDS)
      .populate('createdBy', 'name');

    return res.status(200).json({ room: sanitizeRoom(fresh), joined: !alreadyMember });
  } catch (err) {
    console.error('joinProjectRoom error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE /api/group-chat/rooms/:roomId/messages/:messageId
 *
 * Removes a message from a group. `deleted` already existed on GroupMessage and
 * getMessages already filters on it, but nothing could ever set it — so posted
 * media was permanent. A builder needs to be able to take their own photos down.
 *
 * Allowed for: the sender of the message, an admin/captain, or the owner of the
 * room (their company group / a property they own).
 *
 * Media messages also have their R2 object removed. Group attachments live under
 * `groups/{roomId}/…` and are never referenced anywhere else, so deleting the
 * object cannot break a project gallery or a share link. The DB write happens
 * first: a failed R2 delete leaves an orphaned file, which is harmless, whereas
 * the reverse would leave a message pointing at a missing image.
 */
exports.deleteMessage = async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(String(roomId)) ||
        !mongoose.Types.ObjectId.isValid(String(messageId))) {
      return res.status(400).json({ error: 'Invalid roomId or messageId' });
    }

    const room = await GroupRoom.findOne({
      _id: roomId,
      active: true,
      'members.user': userId,
    }).select('_id builder project').populate('project', 'owner').lean();
    if (!room) {
      return res.status(403).json({ error: 'Not an active member of this group' });
    }

    const message = await GroupMessage.findOne({ _id: messageId, room: roomId });
    if (!message || message.deleted) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // System messages are part of the room's history, not user content.
    if (message.messageType === 'system') {
      return res.status(403).json({ error: 'System messages cannot be deleted' });
    }

    const isSender = String(message.sender) === String(userId);
    if (!isSender && !canPublishMedia(room, req.user)) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }

    message.deleted = true;
    await message.save();

    // Only group attachments are safe to remove from storage.
    const key = message.attachment?.key;
    if (key && String(key).startsWith(`groups/${roomId}/`)) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }));
      } catch (storageErr) {
        // Non-fatal: the message is already gone from the group.
        console.error('deleteMessage: R2 cleanup failed:', storageErr.message);
      }
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`group_${roomId}`).emit('group_message_deleted', {
        roomId,
        messageId: String(message._id),
      });
    }

    return res.status(200).json({ message: 'Message deleted', messageId: String(message._id) });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/group-chat/rooms/:roomId/read
 *
 * Marks the room read for the caller by stamping their membership row. The
 * client calls this when a room is opened, which is what clears its unread badge.
 */
exports.markRoomRead = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
      return res.status(400).json({ error: 'Invalid roomId' });
    }

    // The positional operator updates only the caller's membership row, so this
    // can never touch another member's read marker.
    const result = await GroupRoom.updateOne(
      { _id: roomId, active: true, 'members.user': userId },
      { $set: { 'members.$.lastReadAt': new Date() } }
    );

    const matched = result.matchedCount ?? result.n ?? 0;
    if (matched === 0) {
      return res.status(403).json({ error: 'Not an active member of this group' });
    }

    return res.status(200).json({ message: 'Marked as read', unreadCount: 0 });
  } catch (err) {
    console.error('markRoomRead error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/group-chat/rooms/:roomId/leave
 * Leave a group room (blocked for universal rooms)
 */
exports.leaveRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;

    const room = await GroupRoom.findById(roomId);
    if (!room || !room.active) return res.status(404).json({ error: 'Active group not found' });

    // Cannot leave the universal group.
    if (room.isUniversal || room.roomType === 'universal' || room.canLeave === false) {
      return res.status(403).json({ error: 'You cannot exit the universal group' });
    }

    const isMember = room.members.some(m => m.user.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    // The room/property owner must close the group for everyone, not exit and
    // leave an ownerless group behind. The mobile menu mirrors this rule:
    // non-owner => Exit Group; owner => Delete Group.
    const isOwner = room.createdBy?.toString() === userId.toString();
    if (isOwner) {
      return res.status(403).json({ error: 'The group owner cannot exit; delete the group instead' });
    }

    const result = await GroupRoom.updateOne(
      { _id: roomId, active: true, 'members.user': userId },
      { $pull: { members: { user: userId } }, $set: { lastActivity: new Date() } }
    );
    if ((result.modifiedCount ?? result.nModified ?? 0) === 0) {
      return res.status(409).json({ error: 'Group membership already changed' });
    }

    await GroupMessage.create({
      room: roomId,
      sender: userId,
      messageType: 'system',
      content: `${req.user.name} exited the group`
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`group_${roomId}`).emit('group_member_left', {
        roomId,
        userId: userId.toString(),
        name: req.user.name,
      });
    }

    return res.status(200).json({ message: 'Exited group successfully' });
  } catch (err) {
    console.error('leaveRoom error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE /api/group-chat/rooms/:roomId
 * Delete (deactivate) a group room — only allowed for:
 *   - The room creator (project owner / captain)
 *   - Admin
 * Used when a property is sold and the sub-group is no longer needed.
 */
exports.deleteRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;
    const userRole = req.user.role;

    const room = await GroupRoom.findById(roomId);
    if (!room) return res.status(404).json({ error: 'Group not found' });
    if (!room.active) return res.status(409).json({ error: 'Group is already deleted' });

    // Cannot delete the universal group, regardless of how it was created.
    if (room.isUniversal || room.roomType === 'universal') {
      return res.status(403).json({ error: 'The universal group cannot be deleted' });
    }

    // The property/area owner is the room creator. A platform admin retains an
    // emergency override, but ordinary room admins cannot delete somebody
    // else's property group.
    const isOwner = room.createdBy?.toString() === userId.toString();
    const isPlatformAdmin = userRole === 'admin';
    if (!isOwner && !isPlatformAdmin) {
      return res.status(403).json({ error: 'Only the group owner can delete this group' });
    }

    // Atomic active→inactive transition. This is the dedupe guard: two DELETEs
    // racing each other cannot both create system/admin notifications.
    const deletedRoom = await GroupRoom.findOneAndUpdate(
      { _id: roomId, active: true },
      { $set: { active: false, lastActivity: new Date() } },
      { new: true }
    ).lean();
    if (!deletedRoom) {
      return res.status(409).json({ error: 'Group is already deleted' });
    }

    const linkedProjectId = deletedRoom.project || null;
    const subject = deletedRoom.roomType === 'project' ? 'Property group' : 'Group';

    await GroupMessage.create({
      room: roomId,
      sender: userId,
      messageType: 'system',
      content: `${subject} deleted by ${req.user.name}`
    });

    const io = req.app.get('io');

    // Notify every active HUMAN platform admin. The system assistant also has
    // role=admin, so it must be excluded explicitly. Notification failure is
    // non-fatal because the group is already correctly deactivated.
    try {
      const admins = await User.find({
        role: 'admin',
        isActive: true,
        isSystemAssistant: { $ne: true },
      }).select('_id').lean();

      if (admins.length > 0) {
        const title = 'Group deleted';
        const message = `"${deletedRoom.name}" was deleted by ${req.user.name}`;
        await Notification.insertMany(admins.map(admin => ({
          recipient: admin._id,
          type: 'system',
          title,
          message,
          reference: { model: 'GroupRoom', id: deletedRoom._id },
        })));

        if (io) {
          for (const admin of admins) {
            io.to(admin._id.toString()).emit('notification', {
              type: 'system',
              title,
              message,
              roomId: deletedRoom._id,
              projectId: linkedProjectId,
            });
          }
        }
      }
    } catch (notifyErr) {
      console.error('deleteRoom admin notification failed (non-fatal):', notifyErr.message);
    }

    // Notify every member currently viewing the room so their UI closes it.
    if (io) {
      io.to(`group_${roomId}`).emit('group_deleted', {
        roomId,
        message: `"${deletedRoom.name}" has been deleted by ${req.user.name}`,
      });
    }

    return res.status(200).json({ message: 'Group deleted successfully' });
  } catch (err) {
    console.error('deleteRoom error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════
// GROUP ATTACHMENTS
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/group-chat/rooms/:roomId/attachments
 *
 * Upload a chat attachment without mutating the linked Project. The previous
 * mobile path reused `/files/proxy-upload`, which required a projectId and saved
 * chat photos into Project.galleryImages (or replaced its brochure). That made
 * universal/area uploads impossible and changed property media as a side
 * effect of sending a chat message.
 *
 * This route is mounted after protect/restrictTo and verifies active room
 * membership before putting bytes in R2.
 */
exports.uploadAttachment = async (req, res) => {
  try {
    const { roomId } = req.params;
    const file = req.file;
    const kind = req.body?.kind;

    if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
      return res.status(400).json({ error: 'Invalid roomId' });
    }

    // Membership first, then publish rights. The room has to be loaded before
    // the rights check now, because a builder's permission depends on whether
    // this is one of THEIR rooms. Both run before any bytes reach R2.
    const room = await GroupRoom.findOne({
      _id: roomId,
      active: true,
      'members.user': req.user._id,
    }).select('_id builder project').populate('project', 'owner').lean();
    if (!room) {
      return res.status(403).json({ error: 'Not an active member of this group' });
    }

    if (!canPublishMedia(room, req.user)) {
      return res.status(403).json({
        error: 'You can only upload photos or files in your own groups',
      });
    }

    if (!file || !['image', 'file'].includes(kind)) {
      return res.status(400).json({ error: 'File and kind (image/file) are required' });
    }

    const allowedImages = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedFiles = ['application/pdf'];
    const allowed = kind === 'image' ? allowedImages : allowedFiles;
    if (!allowed.includes(file.mimetype)) {
      return res.status(400).json({
        error: kind === 'image'
          ? 'Only JPEG, PNG and WebP images are supported'
          : 'Only PDF files are supported',
      });
    }

    const safeName = String(file.originalname || `${kind}-${Date.now()}`)
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .slice(-180);
    const fileKey = `groups/${roomId}/${kind}/${crypto.randomUUID()}-${safeName}`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileKey}`;
    return res.status(201).json({
      fileUrl,
      fileKey,
      attachment: {
        name: file.originalname || safeName,
        mimeType: file.mimetype,
        size: file.size,
        key: fileKey,
      },
    });
  } catch (err) {
    console.error('uploadGroupAttachment error:', err);
    return res.status(500).json({ error: 'Attachment upload failed', detail: err.message });
  }
};

// ═══════════════════════════════════════════════════════════
// GROUP MESSAGES
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/group-chat/rooms/:roomId/messages
 * Get messages for a room (paginated)
 */
exports.getMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    // Verify active membership
    const room = await GroupRoom.findOne({ _id: roomId, active: true, 'members.user': userId });
    if (!room) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const messages = await GroupMessage.find({ room: roomId, deleted: false })
      .populate('sender', MESSAGE_SENDER_FIELDS)
      .populate('inventoryCard.project', 'projectName slug media')
      .populate(MATCH_PROJECT_POPULATE)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const payload = await attachMatchGroups(messages.reverse().map(sanitizeMessage));

    res.status(200).json({ messages: payload, page, limit });
  } catch (err) {
    console.error('getMessages error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/group-chat/rooms/:roomId/media
 *
 * The photos / documents / links shared in a room, for the group-info sheet's
 * "Media & Links" section. The thread itself already renders media inline from
 * the message list, but group info needs them without paging back through the
 * whole history, so this is a separate, narrower query.
 *
 * Membership is checked exactly the way getMessages() checks it — a room's media
 * is as private as its messages, so a non-member (or an unauthenticated caller,
 * stopped earlier by `protect`) gets 403 and nothing else.
 *
 * Both queries are paginated and capped. An unbounded list would be a real
 * problem here: the universal room holds every user's messages, and media/link
 * history grows without limit.
 */
exports.getRoomMedia = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    // Hard ceiling, not just a default: a caller asking for limit=100000 must not
    // be able to turn this into a full history dump. The lower bound matters too —
    // a negative value reaches the driver as "close the cursor early", which is
    // confusing rather than wrong, so it is normalised away here.
    const limit = Math.max(Math.min(parseInt(req.query.limit) || 30, 60), 1);
    const skip = (page - 1) * limit;

    if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
      return res.status(400).json({ error: 'Invalid roomId' });
    }

    // Verify active membership — same filter and same 403 as getMessages().
    const room = await GroupRoom.findOne({ _id: roomId, active: true, 'members.user': userId });
    if (!room) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const [mediaDocs, linkDocs] = await Promise.all([
      // Matches the existing { messageType: 1, room: 1 } index on GroupMessage.
      GroupMessage.find({
        room: roomId,
        deleted: false,
        messageType: { $in: ['image', 'file'] }
      })
        .populate('sender', MESSAGE_SENDER_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),

      // Links are not a stored field, so they have to be recognised in the text.
      // A regex is unindexed, but it only ever scans the text messages of ONE
      // room and is bounded by skip/limit — far cheaper than the alternative,
      // which would be extracting URLs from the room's entire history in Node.
      // Extracting the URL itself is left to the client, which already has to
      // parse the message text for the thread view.
      GroupMessage.find({
        room: roomId,
        deleted: false,
        messageType: 'text',
        content: { $regex: 'https?://', $options: 'i' }
      })
        .populate('sender', MESSAGE_SENDER_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
    ]);

    // sanitizeMessage() strips the sender's phone for everything that is not an
    // inventory card. Media and links never are, so no number ships from here —
    // that is precisely the leak sanitizeMessage() was written to close.
    res.status(200).json({
      media: mediaDocs.map(sanitizeMessage),
      links: linkDocs.map(sanitizeMessage),
      page,
      limit
    });
  } catch (err) {
    console.error('getRoomMedia error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/group-chat/rooms/:roomId/messages
 * Post a message (text, inventory card, or requirement card)
 */
exports.postMessage = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;
    const { messageType, content, inventoryCard, requirementCard, attachment } = req.body;

    // Verify active membership. Soft-deleted rooms used to remain writable over
    // REST even though the socket path correctly blocked them.
    // `project.owner` is populated because canPublishMedia() needs it to tell
    // whether this is one of the caller's own property groups.
    const room = await GroupRoom.findOne({ _id: roomId, active: true, 'members.user': userId })
      .populate('project', 'owner');
    if (!room) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    // Project sub-groups are scoped to a single project — requirement/inventory
    // discovery cards don't belong here (they belong in community/area rooms).
    if (room.roomType === 'project' && (messageType === 'inventory_card' || messageType === 'requirement_card')) {
      return res.status(400).json({ error: 'Requirement and inventory cards are not allowed in project groups' });
    }

    const msgData = {
      room: roomId,
      sender: userId,
      messageType: messageType || 'text',
      content: content || ''
    };

    // Same rule as the upload endpoint: without this, a non-privileged member
    // could skip /attachments and post a media message pointing at any URL.
    if (messageType === 'image' || messageType === 'file') {
      if (!canPublishMedia(room, req.user)) {
        return res.status(403).json({
          error: 'You can only share photos or files in your own groups',
        });
      }
      if (attachment) {
        msgData.attachment = {
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          key: attachment.key,
        };
      }
    }

    // Builder posts inventory card
    if (messageType === 'inventory_card' && inventoryCard) {
      if (req.user.role !== 'builder' && req.user.role !== 'admin' && req.user.role !== 'captain' && req.user.role !== 'agent') {
        return res.status(403).json({ error: 'Only builders can post inventory cards' });
      }
      msgData.inventoryCard = inventoryCard;
    }

    // Agent posts requirement card
    if (messageType === 'requirement_card' && requirementCard) {
      if (req.user.role !== 'agent' && req.user.role !== 'admin' && req.user.role !== 'captain') {
        return res.status(403).json({ error: 'Only agents can post requirement cards' });
      }
      msgData.requirementCard = requirementCard;
    }

    const message = await GroupMessage.create(msgData);

    // === AI AUTO-MATCH for requirement cards ===
    if (messageType === 'requirement_card' && requirementCard) {
      const matches = await matchEngine.findMatches(requirementCard, {
        limit: 5,
        excludeOwner: userId // Don't match agent's own projects
      });

      if (matches.length > 0) {
        message.matchResults = matches.map(m => ({
          project: m.project._id,
          score: m.score,
          matchedOn: m.matchedOn
        }));
        await message.save();
      }
    }

    // Update room last activity
    room.lastActivity = new Date();
    await room.save();

    // Populate for response
    await message.populate('sender', MESSAGE_SENDER_FIELDS);
    await message.populate('inventoryCard.project', 'projectName slug media');
    await message.populate(MATCH_PROJECT_POPULATE);

    const payload = await attachMatchGroups(sanitizeMessage(message));

    // Broadcast via Socket.io to room members
    const io = req.app.get('io');
    if (io) {
      io.to(`group_${roomId}`).emit('group_message', {
        ...payload,
        roomId
      });

      // If matches found, emit match notification to the agent
      if (message.matchResults?.length > 0) {
        io.to(userId.toString()).emit('match_results', {
          messageId: message._id,
          roomId,
          matches: message.matchResults,
          requirement: requirementCard
        });
      }
    }

    // === LEAD CAPTURE ===
    // For text messages: frontend now drives this via the confirmation modal.
    // For requirement_card and inventory_card: still handled via form integration below.
    // NOTE: Text message lead capture removed from here — frontend calls /confirm endpoint.

    // === LEAD CAPTURE for requirement_card forms ===
    if (messageType === 'requirement_card' && requirementCard) {
      const budgetInLakhs = requirementCard.budget > 10000 ? Math.round(requirementCard.budget / 100000) : requirementCard.budget;
      const reqText = `need ${requirementCard.bhkType || ''} ${requirementCard.area || ''} ${requirementCard.city || ''} ${budgetInLakhs ? budgetInLakhs + 'L' : ''} ${requirementCard.possessionNeeded || ''} ${requirementCard.loanRequired ? 'loan required' : ''}`.trim();
      const io = req.app.get('io');
      leadCaptureService.processMessage({
        text: reqText,
        sender: { _id: userId, name: req.user.name, role: req.user.role },
        source: 'group_chat',
        messageId: message._id,
        roomId,
        io
      }).catch(err => {
        console.error('LeadCapture (requirement_card) non-blocking error:', err.message);
      });
    }

    // === LEAD CAPTURE for inventory_card forms ===
    if (messageType === 'inventory_card' && inventoryCard) {
      const invBudgetInLakhs = inventoryCard.priceRange?.min > 10000 ? Math.round(inventoryCard.priceRange.min / 100000) : (inventoryCard.priceRange?.min || '');
      const invText = `I have ${inventoryCard.bhkOptions?.join('/') || ''} flat ${inventoryCard.area || ''} ${inventoryCard.city || ''} ${invBudgetInLakhs ? invBudgetInLakhs + 'L' : ''} ${inventoryCard.possessionStatus || ''} ${inventoryCard.bankLoanAvailable ? 'loan available' : ''}`.trim();
      const io = req.app.get('io');
      leadCaptureService.processMessage({
        text: invText,
        sender: { _id: userId, name: req.user.name, role: req.user.role },
        source: 'group_chat',
        messageId: message._id,
        roomId,
        io
      }).catch(err => {
        console.error('LeadCapture (inventory_card) non-blocking error:', err.message);
      });
    }

    res.status(201).json({ message: payload });
  } catch (err) {
    console.error('postMessage error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════
// DEAL ROOMS — "Interested" Button Flow
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/group-chat/interested
 * Agent clicks "Interested" on a matched project → notify builder + create deal room
 */
exports.showInterest = async (req, res) => {
  try {
    const { projectId, messageId, roomId } = req.body;
    const agentId = req.user._id;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    // Get the project + builder info
    const project = await Project.findById(projectId).populate('owner', 'name phone role companyName');
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const builderId = project.owner._id;

    // Check if deal room already exists for this agent+project combo
    const existingDeal = await DealRoom.findOne({
      agent: agentId,
      project: projectId,
      status: { $nin: ['closed_won', 'closed_lost'] }
    });

    if (existingDeal) {
      return res.status(409).json({
        error: 'Deal room already exists for this project',
        dealRoom: existingDeal
      });
    }

    // Get the requirement message for context
    let requirementMsg = null;
    if (messageId) {
      requirementMsg = await GroupMessage.findById(messageId);
    }

    // Create a private ChatSession between agent & builder for this deal
    let chatSession = await ChatSession.findOne({
      participants: { $all: [agentId, builderId] },
      projectContext: projectId,
      active: true
    });

    if (!chatSession) {
      chatSession = await ChatSession.create({
        participants: [agentId, builderId],
        projectContext: projectId
      });
    }

    // Create the Deal Room
    const dealRoom = await DealRoom.create({
      agent: agentId,
      builder: builderId,
      project: projectId,
      requirementMessage: messageId || null,
      groupRoom: roomId || null,
      clientBudget: requirementMsg?.requirementCard?.budget || 0,
      projectPrice: project.pricing?.startingPrice ? project.pricing.startingPrice / 100000 : 0,
      commissionPercent: 0, // To be negotiated
      status: 'initiated',
      chatSession: chatSession._id,
      statusHistory: [{ from: null, to: 'initiated', changedBy: agentId }]
    });

    // Notify builder.
    // Non-fatal: the DealRoom + ChatSession are already persisted by this point,
    // so a notification failure must not fail the request and leave the client
    // thinking the deal wasn't created.
    try {
      await Notification.create({
        recipient: builderId,
        type: 'deal_interest',
        title: 'New Deal Interest!',
        message: `${req.user.name} (Agent) is interested in ${project.projectName}`,
        reference: { model: 'DealRoom', id: dealRoom._id }
      });
    } catch (notifyErr) {
      console.error('showInterest notification failed (non-fatal):', notifyErr.message);
    }

    // Real-time notification to builder
    const io = req.app.get('io');
    if (io) {
      io.to(builderId.toString()).emit('notification', {
        type: 'deal_interest',
        title: 'New Deal Interest!',
        message: `${req.user.name} is interested in ${project.projectName}`,
        dealRoomId: dealRoom._id,
        projectId: project._id
      });
    }

    await dealRoom.populate('agent', 'name role companyName phone');
    await dealRoom.populate('builder', 'name role companyName phone');
    await dealRoom.populate('project', 'projectName city location pricing slug media');

    res.status(201).json({
      dealRoom,
      chatSession: chatSession._id,
      message: 'Builder has been notified of your interest!'
    });
  } catch (err) {
    console.error('showInterest error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/group-chat/deals
 * Get all deal rooms for the current user (as agent or builder)
 */
exports.getDeals = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status } = req.query;

    const filter = {
      $or: [{ agent: userId }, { builder: userId }]
    };
    if (status) filter.status = status;

    const deals = await DealRoom.find(filter)
      .populate('agent', 'name role companyName phone')
      .populate('builder', 'name role companyName phone')
      .populate('project', 'projectName city location pricing media slug')
      .sort({ updatedAt: -1 });

    res.status(200).json({ deals });
  } catch (err) {
    console.error('getDeals error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /api/group-chat/deals/:dealId/status
 * Update deal room status
 */
exports.updateDealStatus = async (req, res) => {
  try {
    const { dealId } = req.params;
    const { status, note, commissionPercent } = req.body;
    const userId = req.user._id;

    const deal = await DealRoom.findOne({
      _id: dealId,
      $or: [{ agent: userId }, { builder: userId }]
    });

    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const previousStatus = deal.status;
    deal.status = status;
    deal.statusHistory.push({ from: previousStatus, to: status, changedBy: userId });

    if (commissionPercent !== undefined) {
      deal.commissionPercent = commissionPercent;
      deal.commissionAmount = (deal.projectPrice * commissionPercent) / 100;
    }
    if (note) {
      deal.notes.push({ content: note, addedBy: userId });
    }

    await deal.save();

    // Notify the other party.
    // Non-fatal for the same reason as showInterest — the status change is
    // already saved above.
    const recipientId = userId.toString() === deal.agent.toString()
      ? deal.builder
      : deal.agent;

    try {
      await Notification.create({
        recipient: recipientId,
        type: 'deal_status_update',
        title: 'Deal Status Updated',
        message: `Deal moved from "${previousStatus}" to "${status}"`,
        reference: { model: 'DealRoom', id: deal._id }
      });
    } catch (notifyErr) {
      console.error('updateDealStatus notification failed (non-fatal):', notifyErr.message);
    }

    const io = req.app.get('io');
    if (io) {
      io.to(recipientId.toString()).emit('notification', {
        type: 'deal_status_update',
        dealRoomId: deal._id,
        status,
        previousStatus
      });
    }

    await deal.populate('agent', 'name role companyName');
    await deal.populate('builder', 'name role companyName');
    await deal.populate('project', 'projectName city location pricing slug media');

    res.status(200).json({ deal });
  } catch (err) {
    console.error('updateDealStatus error:', err);
    res.status(500).json({ error: err.message });
  }
};
