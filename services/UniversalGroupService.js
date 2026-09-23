const mongoose = require('mongoose');
const GroupRoom = require('../models/GroupRoom');
const User = require('../models/User');

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

  // Atomic guarded push — concurrent registrations used to be able to either
  // duplicate a member or drop one, because this was a read-modify-write on a
  // cached room document.
  const result = await GroupRoom.updateOne(
    { _id: room._id, 'members.user': { $ne: userId } },
    { $push: { members: { user: userId, role: 'member', joinedAt: new Date() } } }
  );
  return (result.modifiedCount ?? result.nModified ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT GROUPS
//
// Every project/property gets exactly ONE active group, linked by `project`.
// The uniqueness guarantee lives in the database (partial unique index
// `uniq_active_project_room` on GroupRoom), not in application logic — see
// models/GroupRoom.js for why check-then-act was not enough.
//
// Group creation is driven by the project lifecycle (create / publish / update
// in ProjectController), and additionally by lead matching. All entry points
// funnel through ensureProjectGroup, which is idempotent.
// ═══════════════════════════════════════════════════════════════════════════

// Everything needed to render a complete property card inside its group.
const PROJECT_DETAIL_FIELDS = [
  'projectName', 'projectType', 'category', 'propertyType',
  'city', 'location', 'latitude', 'longitude', 'googleMapLink',
  'reraApproved', 'reraNumber', 'projectStatus',
  'pricing', 'configuration', 'amenities', 'media',
  'slug', 'status', 'owner', 'createdAt', 'updatedAt'
].join(' ');

function trimZeros(s) {
  return String(s).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

/** Format paise-free INR amounts the way Indian real estate reads them. */
function formatINR(value) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '';
  if (value >= 1e7) return `₹${trimZeros((value / 1e7).toFixed(2))} Cr`;
  if (value >= 1e5) return `₹${trimZeros((value / 1e5).toFixed(2))} L`;
  return `₹${value.toLocaleString('en-IN')}`;
}

/**
 * Accept either a project id or a project object. Match results carry a thin
 * projection, so if the detail fields are absent we reload the full document —
 * the group must show every available detail, not just what matching needed.
 */
async function resolveProject(input) {
  if (!input) return null;

  const rawId = input._id || input.id || input;
  const id = rawId ? rawId.toString() : '';
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const looksComplete = typeof input === 'object'
    && input.projectName !== undefined
    && input.media !== undefined
    && input.configuration !== undefined;
  if (looksComplete) return input;

  const Project = require('../models/Project');
  return await Project.findById(id).select(PROJECT_DETAIL_FIELDS).lean();
}

/**
 * Resolve the group's creator/admin. Falls back to a platform admin so we never
 * insert a room with createdBy undefined — the old upsert skipped validators,
 * which allowed exactly that and then crashed on members.some(m => m.user...).
 */
async function resolveOwnerId(project) {
  const owner = project.owner;
  const direct = owner?._id ? owner._id.toString() : (owner ? owner.toString() : '');
  if (direct && mongoose.Types.ObjectId.isValid(direct)) return direct;

  const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
  return admin?._id ? admin._id.toString() : null;
}

/** Stable, human-readable group name derived from the current project data. */
function projectGroupName(project) {
  const where = project.location || project.city || '';
  const base = project.projectName || 'Property';
  return `${base}${where ? ` - ${where}` : ''}`.trim().slice(0, 120);
}

/**
 * The full property snapshot shown at the top of every project group.
 * Only non-empty fields are included so the block never shows "undefined".
 */
function buildProjectDetailsContent(project) {
  const cfg = project.configuration || {};
  const pricing = project.pricing || {};
  const media = project.media || {};

  const galleryCount = (media.galleryImages || []).length;
  const photoCount = (media.coverImage?.url ? 1 : 0) + galleryCount;
  const locality = [project.location, project.city].filter(Boolean).join(', ');
  const type = [project.category, project.propertyType || project.projectType].filter(Boolean).join(' · ');
  const bhk = (cfg.bhkOptions || []).filter(Boolean).join(', ');
  const area = cfg.carpetAreaRange || cfg.plotSizeRange || '';

  const lines = [
    `📋 ${project.projectName || 'Property'}`,
    locality ? `📍 Location: ${locality}` : '',
    type ? `🏷️ Type: ${type}` : '',
    bhk ? `🏠 Configuration: ${bhk}` : '',
    area ? `📐 Area: ${area}` : '',
    formatINR(pricing.startingPrice) ? `💰 Starting Price: ${formatINR(pricing.startingPrice)}` : '',
    pricing.totalPriceRange ? `💵 Price Range: ${pricing.totalPriceRange}` : '',
    formatINR(pricing.pricePerSqFt) ? `📊 Rate: ${formatINR(pricing.pricePerSqFt)}/sq.ft` : '',
    project.projectStatus ? `🔄 Possession / Status: ${project.projectStatus}` : '',
    cfg.floorRange ? `🏢 Floors: ${cfg.floorRange}` : '',
    (cfg.facingOptions || []).length ? `🧭 Facing: ${cfg.facingOptions.join(', ')}` : '',
    cfg.gatedCommunity ? '🚧 Gated Community' : '',
    pricing.bankLoanAvailable ? '🏦 Bank Loan Available' : '',
    project.reraNumber
      ? `📑 RERA: ${project.reraNumber}`
      : (project.reraApproved ? '📑 RERA Approved' : ''),
    (project.amenities || []).length ? `✨ Amenities: ${project.amenities.slice(0, 15).join(', ')}` : '',
    pricing.paymentPlan ? `🧾 Payment Plan: ${pricing.paymentPlan}` : '',
    pricing.maintenanceCharges ? `🔧 Maintenance: ${pricing.maintenanceCharges}` : '',
    photoCount ? `🖼️ Photos: ${photoCount}` : '',
    media.brochurePdf?.url ? '📄 Brochure available' : '',
    media.layoutImage?.url ? '🗂️ Layout plan available' : '',
    project.googleMapLink ? `🗺️ Map: ${project.googleMapLink}` : ''
  ].filter(Boolean);

  // content has maxlength 5000 on the schema.
  return lines.join('\n').slice(0, 5000);
}

/**
 * Create or refresh THE single pinned property-details message for a group.
 * Updated in place so the group always reflects the latest property data
 * without ever accumulating duplicate detail blocks.
 */
async function upsertProjectDetailsMessage(roomId, project, senderId) {
  const GroupMessage = require('../models/GroupMessage');
  const content = buildProjectDetailsContent(project);

  const existing = await GroupMessage.findOne({ room: roomId, isProjectDetails: true });

  // Adopt a legacy details message (posted before isProjectDetails existed) so
  // we edit it rather than adding a second block above it.
  if (!existing) {
    const legacy = await GroupMessage
      .findOne({ room: roomId, messageType: 'system', content: { $regex: '^📋' } })
      .sort({ createdAt: 1 });

    if (legacy) {
      legacy.isProjectDetails = true;
      legacy.content = content;
      legacy.deleted = false;
      // Set the single path rather than reassigning inventoryCard: spreading a
      // Mongoose subdocument materialises its unset paths as undefined, which
      // then fails casting (inventoryCard.priceRange expects an object).
      legacy.set('inventoryCard.project', project._id);
      await legacy.save();
      return;
    }
  }

  try {
    await GroupMessage.findOneAndUpdate(
      { room: roomId, isProjectDetails: true },
      {
        $set: {
          content,
          messageType: 'system',
          deleted: false,
          'inventoryCard.project': project._id
        },
        $setOnInsert: { room: roomId, sender: senderId, isProjectDetails: true }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // Another writer inserted it first — the unique index did its job.
    if (err?.code !== 11000) throw err;
  }
}

/**
 * Ensure a project has exactly one active group, correctly linked, with its
 * details up to date. Idempotent and safe to call concurrently.
 *
 * @param {Object|string} projectInput - project document, lean object, or id
 * @param {Object} io - socket.io instance (optional)
 * @returns {Object|null} - { room, isNew, project } or null if not creatable
 */
async function ensureProjectGroup(projectInput, io) {
  const project = await resolveProject(projectInput);
  if (!project || !project._id) return null;

  const projectId = project._id.toString();
  const ownerId = await resolveOwnerId(project);
  if (!ownerId) {
    console.warn(`[ProjectGroup] No owner and no admin available — skipping group for project ${projectId}`);
    return null;
  }

  const name = projectGroupName(project);
  const description = `Official group for ${project.projectName || 'this property'}. Property details, updates and deal discussions live here.`.slice(0, 500);

  let room = await GroupRoom.findOne({ project: projectId, roomType: 'project', active: true });
  let isNew = false;

  if (!room) {
    try {
      // create() (not findOneAndUpdate upsert) so schema validators actually
      // run; the unique index serialises concurrent creators via E11000.
      room = await GroupRoom.create({
        name,
        roomType: 'project',
        project: projectId,
        createdBy: ownerId,
        description,
        members: [{ user: ownerId, role: 'admin' }],
        isUniversal: false,
        canLeave: true,
        isAutoCreated: true,
        active: true,
        lastActivity: new Date()
      });
      isNew = true;
    } catch (err) {
      if (err?.code === 11000) {
        room = await GroupRoom.findOne({ project: projectId, roomType: 'project', active: true });
      } else {
        throw err;
      }
    }
  }

  if (!room) return null;

  // Keep name/description aligned with the current project data (the old code
  // snapshotted the name at creation and never refreshed it).
  const patch = {};
  if (room.name !== name) patch.name = name;
  if (room.description !== description) patch.description = description;
  if (Object.keys(patch).length) {
    await GroupRoom.updateOne({ _id: room._id }, { $set: patch });
    Object.assign(room, patch);
  }

  await upsertProjectDetailsMessage(room._id, project, room.createdBy || ownerId);

  if (isNew && io) {
    io.to(ownerId).emit('notification', {
      type: 'sub_group_created',
      title: 'Property Group Created',
      message: `A group was created for "${project.projectName}"`,
      roomId: room._id
    });
  }

  return { room, isNew, project };
}

/**
 * Refresh a project's group after the project changes (name, price, media…).
 * Creates the group if it is somehow missing, so update also self-heals.
 */
async function syncProjectGroup(projectInput, io) {
  return await ensureProjectGroup(projectInput, io);
}

/**
 * Deactivate a project's group(s) when the project is deleted, so the group
 * stops surfacing in Discover as an orphan pointing at a dead project.
 */
async function deactivateProjectGroup(projectId, io) {
  if (!projectId || !mongoose.Types.ObjectId.isValid(projectId.toString())) return 0;

  const rooms = await GroupRoom
    .find({ project: projectId, roomType: 'project', active: true })
    .select('_id name')
    .lean();
  if (!rooms.length) return 0;

  await GroupRoom.updateMany(
    { _id: { $in: rooms.map(r => r._id) } },
    { $set: { active: false } }
  );

  if (io) {
    for (const r of rooms) {
      io.to(`group_${r._id}`).emit('group_deleted', {
        roomId: r._id.toString(),
        message: `"${r.name}" has been closed — property removed`
      });
    }
  }

  return rooms.length;
}

/**
 * Create/find a project group for lead matching and add the matched agent.
 * Signature and return shape preserved for existing callers.
 *
 * @param {Object} project - The matched project (populated with owner)
 * @param {string} agentId - The agent whose requirement matched
 * @param {Object} io - Socket.io instance for real-time notifications
 * @returns {Object} - { room, isNew, alreadyMember }
 */
async function findOrCreateProjectSubGroup(project, agentId, io) {
  const ensured = await ensureProjectGroup(project, null);
  if (!ensured) return { room: null, isNew: false, alreadyMember: false };

  const { room, isNew, project: full } = ensured;
  const ownerId = room.createdBy ? room.createdBy.toString() : '';
  const groupName = room.name;

  if (!agentId || !mongoose.Types.ObjectId.isValid(agentId.toString())) {
    return { room, isNew, alreadyMember: false };
  }

  // Atomic guarded push: the "not already a member" condition lives in the
  // filter, so concurrent matches can neither duplicate a member nor clobber
  // each other (the old members.push() + save() was a read-modify-write).
  const result = await GroupRoom.updateOne(
    { _id: room._id, 'members.user': { $ne: agentId } },
    {
      $push: { members: { user: agentId, role: 'member', joinedAt: new Date() } },
      $set: { lastActivity: new Date() }
    }
  );
  const added = (result.modifiedCount ?? result.nModified ?? 0) > 0;

  if (added) {
    const GroupMessage = require('../models/GroupMessage');
    const agent = await User.findById(agentId).select('name role').lean();

    await GroupMessage.create({
      room: room._id,
      sender: agentId,
      messageType: 'system',
      content: `${agent?.name || 'An agent'} joined — requirement matched this project`
    });

    if (io) {
      if (ownerId) {
        io.to(ownerId).emit('notification', {
          type: 'sub_group_created',
          title: isNew ? 'New Project Group Created' : 'New Agent in Project Group',
          message: `${agent?.name || 'An agent'} matched your project "${full.projectName}"`,
          roomId: room._id
        });
      }
      io.to(agentId.toString()).emit('notification', {
        type: 'sub_group_joined',
        title: 'Added to Project Group',
        message: `You've been added to "${groupName}" — your requirement matched!`,
        roomId: room._id
      });
    }
  }

  const fresh = await GroupRoom.findById(room._id);
  return { room: fresh || room, isNew, alreadyMember: !added };
}

module.exports = {
  ensureUniversalGroup,
  getUniversalGroup,
  addUserToUniversalGroup,
  findOrCreateProjectSubGroup,
  ensureProjectGroup,
  syncProjectGroup,
  deactivateProjectGroup,
  buildProjectDetailsContent,
  projectGroupName,
  PROJECT_DETAIL_FIELDS,
  clearCache,
  UNIVERSAL_GROUP_NAME
};
