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

      // Post project details as system message
      const projectInfo = [
        `📋 Project: ${project.projectName}`,
        `📍 Location: ${project.location || ''}, ${project.city || ''}`,
        project.pricing?.startingPrice ? `💰 Starting Price: ₹${(project.pricing.startingPrice / 100000).toFixed(0)}L` : '',
        project.configuration?.bhkOptions?.length ? `🏠 Config: ${project.configuration.bhkOptions.join(', ')}` : '',
        project.reraNumber ? `📊 RERA: ${project.reraNumber}` : '',
        project.projectStatus ? `🔄 Status: ${project.projectStatus}` : '',
        project.pricing?.bankLoanAvailable ? '🏦 Bank Loan Available' : ''
      ].filter(Boolean).join('\n');

      await GroupMessage.create({
        room: room._id,
        sender: ownerId,
        messageType: 'system',
        content: projectInfo
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

module.exports = {
  ensureUniversalGroup,
  getUniversalGroup,
  addUserToUniversalGroup,
  findOrCreateProjectSubGroup,
  clearCache,
  UNIVERSAL_GROUP_NAME
};
