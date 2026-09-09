const GroupRoom = require('../models/GroupRoom');
const User = require('../models/User');
const propertyTypeNormalizer = require('./PropertyTypeNormalizer');

/**
 * UniversalGroupService
 * 
 * Manages the single "HIT Community" universal group room.
 * - Ensures it exists on server startup
 * - Provides helper to add new users on registration
 * - Provides helper to create auto sub-groups on lead match
 */

const UNIVERSAL_GROUP_NAME = 'HIT Community';

/**
 * Format a stored sqft size into a human-friendly string. Sizes are stored in
 * sqft (see the upload form / matcher), but for land the seller thinks in acres,
 * so we surface an approximate acre value alongside large sqft figures.
 *
 * "217800 sqft"        → "217800 sqft (≈ 5 acre)"
 * "900 - 5000 sqft"    → "900 - 5000 sqft"
 * "1200"               → "1200 sqft"
 */
function _formatSize(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const nums = (raw.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n > 0);
  if (nums.length === 0) return raw.trim();

  const base = /sq\.?\s*ft|sqft/i.test(raw) ? raw.trim() : `${raw.trim()} sqft`;

  // Add an acre hint when the size is large enough that acres are the natural unit.
  const max = Math.max(...nums);
  if (max >= 20000) {
    const acres = (max / 43560);
    const acreStr = acres >= 10 ? Math.round(acres) : acres.toFixed(2).replace(/\.?0+$/, '');
    return `${base} (≈ ${acreStr} acre)`;
  }
  return base;
}

/**
 * Build the pinned "project details" system message, TYPE-AWARE:
 *   - Land / plot / farm types → show plot size (with acre hint), not BHK.
 *   - BHK-bearing types (flat/villa/etc.) → show BHK config.
 *   - Mixed use → show whichever size/config is present.
 * Kept in one place so both creation and refresh render identical content.
 */
function buildProjectInfoMessage(project) {
  const typeInfo = propertyTypeNormalizer.fromProject(project);
  const isLand = ['plot', 'farm_land', 'commercial_plot'].includes(typeInfo.family);

  const plotSize = project.configuration?.plotSizeRange;
  const carpet = project.configuration?.carpetAreaRange;
  const bhk = project.configuration?.bhkOptions;

  const lines = [
    `📋 Project: ${project.projectName}`,
    `📍 Location: ${project.location || ''}, ${project.city || ''}`,
    project.propertyType ? `🏷️ Type: ${project.propertyType}` : '',
    project.pricing?.startingPrice ? `💰 Starting Price: ₹${(project.pricing.startingPrice / 100000).toFixed(0)}L` : '',
  ];

  if (isLand) {
    // Land/plot/farm: size is the meaningful spec, never BHK.
    const size = _formatSize(plotSize || carpet);
    if (size) lines.push(`📐 Plot Size: ${size}`);
  } else {
    // Built-up: prefer BHK config, and include carpet area when present.
    if (bhk?.length) lines.push(`🏠 Config: ${bhk.join(', ')}`);
    if (carpet) lines.push(`📐 Carpet Area: ${_formatSize(carpet)}`);
    // A non-land project may still carry a plot size (e.g. villa) — show it.
    if (plotSize) lines.push(`📐 Plot Size: ${_formatSize(plotSize)}`);
  }

  lines.push(project.reraNumber ? `📊 RERA: ${project.reraNumber}` : '');
  lines.push(project.projectStatus ? `🔄 Status: ${project.projectStatus}` : '');
  lines.push(project.pricing?.bankLoanAvailable ? '🏦 Bank Loan Available' : '');

  return lines.filter(Boolean).join('\n');
}

/**
 * Ensure the universal group exists. Called on server startup.
 * Creates it if missing, returns the existing one otherwise.
 */
async function ensureUniversalGroup() {
  let room = await GroupRoom.findOne({ isUniversal: true, active: true });

  if (!room) {
    // Find an admin user to set as creator (or use first user)
    const admin = await User.findOne({ role: 'admin' }).select('_id');
    const creatorId = admin?._id || null;

    if (!creatorId) {
      console.warn('[UniversalGroup] No admin user found — will create universal group when first user registers');
      return null;
    }

    room = await GroupRoom.create({
      name: UNIVERSAL_GROUP_NAME,
      roomType: 'universal',
      createdBy: creatorId,
      description: 'The official HIT Community group. All platform members are here. Post requirements and inventory to find matches.',
      members: [{ user: creatorId, role: 'admin' }],
      isUniversal: true,
      canLeave: false,
      active: true,
      lastActivity: new Date()
    });

    console.log(`[UniversalGroup] Created "HIT Community" group: ${room._id}`);
  }

  return room;
}

/**
 * Get the universal group room (cached after first call).
 */
let _cachedRoom = null;
async function getUniversalGroup() {
  if (_cachedRoom) return _cachedRoom;
  _cachedRoom = await GroupRoom.findOne({ isUniversal: true, active: true });
  return _cachedRoom;
}

/**
 * Clear cache (used after creation or if needed).
 */
function clearCache() {
  _cachedRoom = null;
}

/**
 * Add a user to the universal group.
 * Called after registration/verification.
 * 
 * @param {string} userId - The user's ObjectId
 * @returns {boolean} - true if added, false if already a member or group not found
 */
async function addUserToUniversalGroup(userId) {
  const room = await getUniversalGroup();
  if (!room) {
    // Try to create it now
    const created = await ensureUniversalGroup();
    if (!created) return false;
    clearCache();
    return addUserToUniversalGroup(userId);
  }

  // Check if already a member
  const isMember = room.members.some(m => m.user.toString() === userId.toString());
  if (isMember) return false;

  room.members.push({ user: userId, role: 'member' });
  await room.save();
  return true;
}

/**
 * Create or find a project sub-group for lead matching.
 * Called when a requirement matches a project.
 * 
 * @param {Object} project - The matched project (populated with owner)
 * @param {string} agentId - The agent whose requirement matched
 * @param {Object} io - Socket.io instance for real-time notifications
 * @returns {Object} - { room, isNew, alreadyMember }
 */
async function findOrCreateProjectSubGroup(project, agentId, io) {
  const projectId = project._id.toString();
  const ownerId = project.owner?._id?.toString() || project.owner?.toString();
  const groupName = `${project.projectName} - ${project.location || project.city || ''}`.trim();

  // Find existing active sub-group for this project
  let room = await GroupRoom.findOne({
    project: projectId,
    roomType: 'project',
    isAutoCreated: true,
    active: true
  });

  let isNew = false;

  if (!room) {
    // Create new sub-group (use findOneAndUpdate with upsert to avoid race conditions)
    room = await GroupRoom.findOneAndUpdate(
      { project: projectId, roomType: 'project', isAutoCreated: true, active: true },
      {
        $setOnInsert: {
          name: groupName,
          roomType: 'project',
          project: projectId,
          createdBy: ownerId,
          description: `Auto-created group for ${project.projectName}. Discuss deals and requirements here.`,
          members: [{ user: ownerId, role: 'admin' }],
          isUniversal: false,
          canLeave: true,
          isAutoCreated: true,
          active: true,
          lastActivity: new Date()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Check if we just created it (no system message yet means it's new)
    const GroupMessage = require('../models/GroupMessage');
    const existingMsg = await GroupMessage.findOne({ room: room._id, messageType: 'system' });
    if (!existingMsg) {
      isNew = true;

      // Post project details as system message (type-aware — see builder).
      // Content starts with the "📋 Project:" marker so it can be located and
      // refreshed later when the project is edited (see refreshProjectSubGroupPin).
      await GroupMessage.create({
        room: room._id,
        sender: ownerId,
        messageType: 'system',
        content: buildProjectInfoMessage(project)
      });
    }
  }

  // Add agent to sub-group if not already a member
  let alreadyMember = false;
  const isAgentMember = room.members.some(m => m.user.toString() === agentId.toString());

  if (!isAgentMember) {
    room.members.push({ user: agentId, role: 'member' });
    room.lastActivity = new Date();
    await room.save();

    // Post system message about new member
    const GroupMessage = require('../models/GroupMessage');
    const agent = await User.findById(agentId).select('name role');
    await GroupMessage.create({
      room: room._id,
      sender: agentId,
      messageType: 'system',
      content: `${agent?.name || 'An agent'} joined — requirement matched this project`
    });

    // Notify via socket
    if (io) {
      io.to(ownerId).emit('notification', {
        type: 'sub_group_created',
        title: isNew ? 'New Project Group Created' : 'New Agent in Project Group',
        message: `${agent?.name || 'An agent'} matched your project "${project.projectName}"`,
        roomId: room._id
      });
      io.to(agentId.toString()).emit('notification', {
        type: 'sub_group_joined',
        title: 'Added to Project Group',
        message: `You've been added to "${groupName}" — your requirement matched!`,
        roomId: room._id
      });
    }
  } else {
    alreadyMember = true;
  }

  return { room, isNew, alreadyMember };
}

/**
 * Refresh the pinned project-details system message for a project's sub-group.
 *
 * The pin is written once at sub-group creation and would otherwise freeze the
 * project's state at that moment (stale price, old BHK, missing plot size). Call
 * this whenever the project is edited so the pin reflects current details.
 *
 * Non-blocking / idempotent: does nothing if no sub-group exists; updates the
 * existing "📋 Project:" system message in place, or creates one if missing.
 *
 * @param {object} project - The project (should include configuration, pricing,
 *   propertyType, projectStatus). Owner id used as the system-message sender.
 * @param {object} [io] - Socket.io instance to broadcast the update.
 * @returns {Promise<boolean>} true if a pin was updated/created.
 */
async function refreshProjectSubGroupPin(project, io) {
  try {
    if (!project?._id) return false;

    const room = await GroupRoom.findOne({
      project: project._id,
      roomType: 'project',
      isAutoCreated: true,
      active: true
    });
    if (!room) return false; // No sub-group yet — nothing to refresh.

    const GroupMessage = require('../models/GroupMessage');
    const newContent = buildProjectInfoMessage(project);

    // Locate the pinned details message: earliest system message that starts
    // with the "📋 Project:" marker.
    const pin = await GroupMessage.findOne({
      room: room._id,
      messageType: 'system',
      content: { $regex: '^📋 Project:' }
    }).sort({ createdAt: 1 });

    let messageId;
    if (pin) {
      if (pin.content !== newContent) {
        pin.content = newContent;
        await pin.save();
      }
      messageId = pin._id;
    } else {
      const ownerId = project.owner?._id?.toString() || project.owner?.toString();
      const created = await GroupMessage.create({
        room: room._id,
        sender: ownerId,
        messageType: 'system',
        content: newContent
      });
      messageId = created._id;
    }

    // Broadcast so open clients re-render the pin.
    if (io) {
      io.to(`group_${room._id}`).emit('project_info_updated', {
        roomId: room._id.toString(),
        messageId: messageId?.toString(),
        content: newContent
      });
    }

    return true;
  } catch (err) {
    console.error('refreshProjectSubGroupPin error (non-blocking):', err.message);
    return false;
  }
}

/**
 * Build the projectAnnouncement snapshot subdocument from a project.
 * The project should be populated with `owner` (name, companyName, role,
 * verificationStatus[, rating, ratingCount]).
 */
function _buildAnnouncementSnapshot(project, kind, changedFields = []) {
  const owner = project.owner || {};
  const verifiedBuilder =
    owner.isVerifiedBuilder === true ||
    owner.verificationStatus?.builder === 'verified';

  return {
    project: project._id,
    kind,
    projectName: project.projectName || '',
    coverImageUrl: project.media?.coverImage?.url || '',
    slug: project.slug || '',
    location: project.location || '',
    city: project.city || '',
    startingPrice: project.pricing?.startingPrice || 0,
    bhkOptions: project.configuration?.bhkOptions || [],
    projectStatus: project.projectStatus || '',
    reraNumber: project.reraNumber || '',
    bankLoanAvailable: !!project.pricing?.bankLoanAvailable,
    builderName: owner.name || '',
    builderCompany: owner.companyName || '',
    isVerifiedBuilder: !!verifiedBuilder,
    builderRating: owner.rating || 0,
    changedFields: kind === 'updated' ? changedFields : []
  };
}

/**
 * Detect whether an edit is "significant" enough to announce.
 * Compares a whitelist of buyer-facing fields between the pre-update snapshot
 * and the updated project. Returns a human-readable list of what changed.
 *
 * @param {object} before - Plain project object BEFORE the update.
 * @param {object} after  - Plain project object AFTER the update.
 * @returns {string[]} - Labels of significant changes (empty = not significant).
 */
function detectSignificantChanges(before, after) {
  const changes = [];
  if (!before || !after) return changes;

  const beforePrice = before.pricing?.startingPrice || 0;
  const afterPrice = after.pricing?.startingPrice || 0;
  if (beforePrice !== afterPrice) changes.push('Price updated');

  if ((before.projectStatus || '') !== (after.projectStatus || '')) {
    changes.push('Status updated');
  }

  const beforeBhk = (before.configuration?.bhkOptions || []).slice().sort().join(',');
  const afterBhk = (after.configuration?.bhkOptions || []).slice().sort().join(',');
  if (beforeBhk !== afterBhk) changes.push('Configuration updated');

  const beforeGallery = before.media?.galleryImages?.length || 0;
  const afterGallery = after.media?.galleryImages?.length || 0;
  if (afterGallery > beforeGallery) changes.push('New photos added');

  const beforeCover = before.media?.coverImage?.url || '';
  const afterCover = after.media?.coverImage?.url || '';
  if (beforeCover !== afterCover) changes.push('Cover image updated');

  return changes;
}

/**
 * Post a persistent project announcement card into the HIT Community room.
 * Non-blocking / idempotent-ish: safe to call fire-and-forget. Snapshots the
 * project + builder identity so the card renders stably over time.
 *
 * @param {object} project - Project populated with `owner`.
 * @param {'new'|'updated'} kind
 * @param {object} [io] - Socket.io instance.
 * @param {string[]} [changedFields] - Only used for kind === 'updated'.
 * @returns {Promise<object|null>} The created message, or null if skipped.
 */
async function postProjectAnnouncement(project, kind = 'new', io, changedFields = []) {
  try {
    if (!project?._id) return null;

    const room = await getUniversalGroup();
    if (!room) return null; // Community room not ready — skip silently.

    const GroupMessage = require('../models/GroupMessage');
    const ownerId = project.owner?._id?.toString() || project.owner?.toString();

    // There is at most ONE announcement card per project. If one already exists,
    // update it in place (flip to "updated", refresh snapshot) instead of posting
    // a second card. This keeps a single, self-updating card in the conversation.
    const existing = await GroupMessage.findOne({
      room: room._id,
      messageType: 'project_announcement',
      'projectAnnouncement.project': project._id
    });

    // If the card already exists, any subsequent announcement is an "update",
    // regardless of the caller's `kind` (e.g. re-publish after edit).
    const effectiveKind = existing ? 'updated' : kind;
    const snapshot = _buildAnnouncementSnapshot(project, effectiveKind, changedFields);
    const content = effectiveKind === 'new'
      ? `New project published: ${snapshot.projectName}`
      : `Project updated: ${snapshot.projectName}`;

    let message;
    let isUpdate = false;

    if (existing) {
      isUpdate = true;
      existing.content = content;
      existing.projectAnnouncement = snapshot;
      existing.sender = ownerId || existing.sender;
      await existing.save();
      message = existing;
    } else {
      message = await GroupMessage.create({
        room: room._id,
        sender: ownerId,
        messageType: 'project_announcement',
        content,
        projectAnnouncement: snapshot
      });
    }

    // Bump room activity so it surfaces at the top of everyone's list.
    await GroupRoom.updateOne({ _id: room._id }, { $set: { lastActivity: new Date() } });

    // Broadcast to open clients in the community room.
    if (io) {
      const populated = await GroupMessage.findById(message._id)
        .populate('sender', 'name role companyName')
        .lean();
      const payload = { ...populated, roomId: room._id.toString() };
      // New card → append via the normal message event.
      // Existing card → dedicated update event so clients replace it in place.
      io.to(`group_${room._id}`).emit(
        isUpdate ? 'project_announcement_updated' : 'group_message',
        payload
      );
    }

    return message;
  } catch (err) {
    console.error('postProjectAnnouncement error (non-blocking):', err.message);
    return null;
  }
}

module.exports = {
  ensureUniversalGroup,
  getUniversalGroup,
  addUserToUniversalGroup,
  findOrCreateProjectSubGroup,
  refreshProjectSubGroupPin,
  buildProjectInfoMessage,
  postProjectAnnouncement,
  detectSignificantChanges,
  clearCache,
  UNIVERSAL_GROUP_NAME
};
