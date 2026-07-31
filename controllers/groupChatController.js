const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const DealRoom = require('../models/DealRoom');
const ChatSession = require('../models/ChatSession');
const Notification = require('../models/Notification');
const Project = require('../models/Project');
const matchEngine = require('../services/MatchEngine');
const leadCaptureService = require('../services/LeadCaptureService');

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

    // Check if a room already exists for this project
    if (roomType === 'project') {
      const existing = await GroupRoom.findOne({ project: projectId, active: true });
      if (existing) {
        return res.status(409).json({ error: 'Room already exists for this project', room: existing });
      }
    }

    const room = await GroupRoom.create({
      name,
      roomType,
      project: roomType === 'project' ? projectId : null,
      area: roomType === 'area' ? area : undefined,
      createdBy: userId,
      description: description || '',
      members: [{ user: userId, role: 'admin' }],
      lastActivity: new Date()
    });

    await room.populate('members.user', 'name role companyName');
    await room.populate('project', 'projectName city location');

    res.status(201).json({ room });
  } catch (err) {
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
      .populate('project', 'projectName city location pricing')
      .populate('members.user', 'name role companyName')
      .populate('createdBy', 'name')
      .sort({ lastActivity: -1 });

    // Get discoverable rooms user hasn't joined
    const discoverFilter = {
      ...filter,
      'members.user': { $ne: userId }
    };
    if (search) {
      discoverFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { 'area.city': { $regex: search, $options: 'i' } },
        { 'area.location': { $regex: search, $options: 'i' } }
      ];
    }

    const discoverRooms = await GroupRoom.find(discoverFilter)
      .populate('project', 'projectName city location')
      .populate('createdBy', 'name')
      .sort({ lastActivity: -1 })
      .limit(20);

    res.status(200).json({ myRooms, discoverRooms });
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

    const room = await GroupRoom.findById(roomId);
    if (!room || !room.active) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Check if already a member
    const isMember = room.members.some(m => m.user.toString() === userId.toString());
    if (isMember) {
      return res.status(200).json({ message: 'Already a member', room });
    }

    room.members.push({ user: userId, role: 'member' });
    await room.save();

    // Post system message
    await GroupMessage.create({
      room: roomId,
      sender: userId,
      messageType: 'system',
      content: `${req.user.name} joined the group`
    });

    await room.populate('members.user', 'name role companyName');
    res.status(200).json({ room });
  } catch (err) {
    console.error('joinRoom error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/group-chat/rooms/:roomId/leave
 * Leave a group room
 */
exports.leaveRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user._id;

    const room = await GroupRoom.findById(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    room.members = room.members.filter(m => m.user.toString() !== userId.toString());
    await room.save();

    // Post system message
    await GroupMessage.create({
      room: roomId,
      sender: userId,
      messageType: 'system',
      content: `${req.user.name} left the group`
    });

    res.status(200).json({ message: 'Left room successfully' });
  } catch (err) {
    console.error('leaveRoom error:', err);
    res.status(500).json({ error: err.message });
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

    // Verify membership
    const room = await GroupRoom.findOne({ _id: roomId, 'members.user': userId });
    if (!room) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const messages = await GroupMessage.find({ room: roomId, deleted: false })
      .populate('sender', 'name role companyName')
      .populate('inventoryCard.project', 'projectName slug media')
      .populate('matchResults.project', 'projectName city location pricing configuration owner slug media')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({ messages: messages.reverse(), page, limit });
  } catch (err) {
    console.error('getMessages error:', err);
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
    const { messageType, content, inventoryCard, requirementCard } = req.body;

    // Verify membership
    const room = await GroupRoom.findOne({ _id: roomId, 'members.user': userId });
    if (!room) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const msgData = {
      room: roomId,
      sender: userId,
      messageType: messageType || 'text',
      content: content || ''
    };

    // Builder posts inventory card
    if (messageType === 'inventory_card' && inventoryCard) {
      if (req.user.role !== 'builder' && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only builders can post inventory cards' });
      }
      msgData.inventoryCard = inventoryCard;
    }

    // Agent posts requirement card
    if (messageType === 'requirement_card' && requirementCard) {
      if (req.user.role !== 'agent' && req.user.role !== 'admin') {
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
    await message.populate('sender', 'name role companyName');
    await message.populate('inventoryCard.project', 'projectName slug media');
    await message.populate('matchResults.project', 'projectName city location pricing configuration owner slug media');

    // Broadcast via Socket.io to room members
    const io = req.app.get('io');
    if (io) {
      io.to(`group_${roomId}`).emit('group_message', {
        ...message.toObject(),
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

    // === NLP LEAD CAPTURE for text messages ===
    // Runs async — detects requirement intent in free text, matches, notifies admin
    if (messageType === 'text' && content && content.length >= 10) {
      // Non-blocking: fire and forget (don't delay the response)
      const io = req.app.get('io');
      leadCaptureService.processMessage({
        text: content,
        sender: { _id: userId, name: req.user.name, role: req.user.role },
        source: 'group_chat',
        messageId: message._id,
        roomId,
        io
      }).catch(err => {
        console.error('LeadCapture (REST) non-blocking error:', err.message);
      });
    }

    res.status(201).json({ message });
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

    // Notify builder
    await Notification.create({
      recipient: builderId,
      type: 'deal_interest',
      title: 'New Deal Interest!',
      message: `${req.user.name} (Agent) is interested in ${project.projectName}`,
      reference: { model: 'DealRoom', id: dealRoom._id }
    });

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
    await dealRoom.populate('project', 'projectName city location pricing');

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

    // Notify the other party
    const recipientId = userId.toString() === deal.agent.toString()
      ? deal.builder
      : deal.agent;

    await Notification.create({
      recipient: recipientId,
      type: 'deal_status_update',
      title: 'Deal Status Updated',
      message: `Deal moved from "${previousStatus}" to "${status}"`,
      reference: { model: 'DealRoom', id: deal._id }
    });

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
    await deal.populate('project', 'projectName city location pricing');

    res.status(200).json({ deal });
  } catch (err) {
    console.error('updateDealStatus error:', err);
    res.status(500).json({ error: err.message });
  }
};
