const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Project = require('../models/Project');
const DealRoom = require('../models/DealRoom');
const ExtractedLead = require('../models/ExtractedLead');

/**
 * POST /api/chat/qualify
 * Submit pre-chat qualification answers & initiate a new chat session (or return existing one)
 */
exports.qualifyAndConnect = async (req, res) => {
  try {
    const { partnerId, answers } = req.body;
    const userId = req.user._id;

    if (!partnerId) {
      return res.status(400).json({ error: 'partnerId is required' });
    }

    // Check partner exists
    const partner = await User.findById(partnerId);
    if (!partner) {
      return res.status(404).json({ error: 'Partner not found' });
    }

    // Check if a session already exists between these two users
    let session = await ChatSession.findOne({
      participants: { $all: [userId, partnerId] },
      active: true
    });

    if (session) {
      // Update qualification data if session already exists
      session.qualificationData = {
        initiator: userId,
        answers: {
          businessScale: answers?.businessScale || 'average',
          reach: answers?.reach || 'average',
          domainCategory: answers?.domainCategory || '',
          yearsInBusiness: answers?.yearsInBusiness || 0,
          projectsCompleted: answers?.projectsCompleted || 0
        }
      };
      await session.save();

      // Populate the session to be returned
      const populatedSession = await ChatSession.findById(session._id)
        .populate('participants', 'name phone role companyName businessLogoUrl')
        .populate('lastMessage.sender', 'name');

      return res.status(200).json({
        session: populatedSession,
        message: 'Existing session found. Qualification updated.',
        isNew: false
      });
    }

    // Create new session
    session = new ChatSession({
      participants: [userId, partnerId],
      qualificationData: {
        initiator: userId,
        answers: {
          businessScale: answers?.businessScale || 'average',
          reach: answers?.reach || 'average',
          domainCategory: answers?.domainCategory || '',
          yearsInBusiness: answers?.yearsInBusiness || 0,
          projectsCompleted: answers?.projectsCompleted || 0
        }
      }
    });
    await session.save();

    // Send notification to partner about new chat request
    await Notification.create({
      recipient: partnerId,
      type: 'new_chat_message',
      title: 'New Chat Request',
      message: `${req.user.name} wants to connect with you`,
      reference: { model: 'ChatSession', id: session._id }
    });

    // Emit real-time notification if socket is available
    if (req.app.get('io')) {
      req.app.get('io').to(partnerId.toString()).emit('notification', {
        type: 'new_chat_message',
        title: 'New Chat Request',
        message: `${req.user.name} wants to connect with you`,
        sessionId: session._id
      });
    }

    const populatedSession = await ChatSession.findById(session._id)
      .populate('participants', 'name phone role companyName businessLogoUrl')
      .populate('lastMessage.sender', 'name');

    res.status(201).json({
      session: populatedSession,
      message: 'Qualification saved. Chat session created.',
      isNew: true
    });
  } catch (err) {
    console.error('qualifyAndConnect error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/chat/sessions
 * Get all chat sessions for the authenticated user
 */
exports.getSessions = async (req, res) => {
  try {
    const userId = req.user._id;

    const sessions = await ChatSession.find({
      participants: userId,
      active: true
    })
      .populate('participants', 'name phone role companyName businessLogoUrl')
      .populate('lastMessage.sender', 'name')
      .sort({ 'lastMessage.timestamp': -1 });

    res.status(200).json({ sessions });
  } catch (err) {
    console.error('getSessions error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/chat/sessions/:sessionId/messages
 * Get messages for a specific chat session (with pagination)
 */
exports.getMessages = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    // Verify user is a participant
    const session = await ChatSession.findOne({
      _id: sessionId,
      participants: userId
    });

    if (!session) {
      return res.status(403).json({ error: 'Not authorized to view this session' });
    }

    const messages = await ChatMessage.find({
      session: sessionId,
      deleted: false
    })
      .populate('sender', 'name role')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Mark messages as read
    await ChatMessage.updateMany(
      {
        session: sessionId,
        sender: { $ne: userId },
        readBy: { $nin: [userId] }
      },
      { $addToSet: { readBy: userId } }
    );

    // Reset unread count for this user
    if (session.unreadCount) {
      session.unreadCount.set(userId.toString(), 0);
      await session.save();
    }

    res.status(200).json({
      messages: messages.reverse(), // Oldest first for display
      page,
      limit
    });
  } catch (err) {
    console.error('getMessages error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/chat/contacts
 * Get list of builders/agents available for chatting
 */
exports.getContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const { search, role } = req.query;

    const filter = {
      _id: { $ne: userId },
      isActive: true,
      role: { $in: ['builder', 'agent'] }
    };

    if (role && ['builder', 'agent'].includes(role)) {
      filter.role = role;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    const contacts = await User.find(filter)
      .select('name phone role companyName businessLogoUrl')
      .sort({ name: 1 })
      .limit(100);

    res.status(200).json({ contacts });
  } catch (err) {
    console.error('getContacts error:', err);
    res.status(500).json({ error: err.message });
  }
};


/**
 * GET /api/chat/builders-network
 * Returns all builders on the platform with FOMO stats for the builder network view.
 * Designed for builders to see other builders (social proof / FOMO).
 * 
 * Query params: search, city, page, limit
 * 
 * Returns per builder:
 *   - name, companyName, businessLogoUrl, verificationStatus, rating
 *   - projectCount, projectLocations
 *   - agentInterestCount (deals initiated in last 30 days)
 *   - dealsClosedCount (all-time closed_won)
 *   - lastSeen, isOnline (lastSeen < 5 min ago)
 * 
 * Also returns platform-wide pulse stats.
 */
exports.getBuildersNetwork = async (req, res) => {
  try {
    const userId = req.user._id;
    const { search, city, page = 1, limit = 30 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build filter for builders
    const filter = {
      _id: { $ne: userId },
      role: 'builder',
      isActive: true
    };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } }
      ];
    }

    if (city) {
      filter.businessCity = { $regex: city, $options: 'i' };
    }

    // Fetch builders
    const builders = await User.find(filter)
      .select('name companyName businessLogoUrl businessCity verificationStatus rating ratingCount lastSeen createdAt')
      .sort({ lastSeen: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalBuilders = await User.countDocuments(filter);

    // Get builder IDs for batch queries
    const builderIds = builders.map(b => b._id);

    // Batch: project counts per builder
    const projectCounts = await Project.aggregate([
      { $match: { owner: { $in: builderIds } } },
      { $group: { _id: '$owner', count: { $sum: 1 }, locations: { $addToSet: '$location' }, cities: { $addToSet: '$city' } } }
    ]);
    const projectMap = {};
    projectCounts.forEach(p => {
      projectMap[p._id.toString()] = {
        count: p.count,
        locations: p.locations.filter(Boolean).slice(0, 3),
        cities: p.cities.filter(Boolean)
      };
    });

    // Batch: agent interest (DealRooms created in last 30 days per builder)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const interestCounts = await DealRoom.aggregate([
      { $match: { builder: { $in: builderIds }, createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: '$builder', count: { $sum: 1 } } }
    ]);
    const interestMap = {};
    interestCounts.forEach(i => { interestMap[i._id.toString()] = i.count; });

    // Batch: deals closed (all-time closed_won per builder)
    const closedCounts = await DealRoom.aggregate([
      { $match: { builder: { $in: builderIds }, status: 'closed_won' } },
      { $group: { _id: '$builder', count: { $sum: 1 } } }
    ]);
    const closedMap = {};
    closedCounts.forEach(c => { closedMap[c._id.toString()] = c.count; });

    // Batch: recent project listings (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentProjects = await Project.aggregate([
      { $match: { owner: { $in: builderIds }, createdAt: { $gte: sevenDaysAgo } } },
      { $group: { _id: '$owner', count: { $sum: 1 } } }
    ]);
    const recentProjectMap = {};
    recentProjects.forEach(r => { recentProjectMap[r._id.toString()] = r.count; });

    // Assemble builder list with FOMO stats
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const buildersWithStats = builders.map(b => {
      const bid = b._id.toString();
      const projects = projectMap[bid] || { count: 0, locations: [], cities: [] };
      return {
        _id: b._id,
        name: b.name,
        companyName: b.companyName || null,
        businessLogoUrl: b.businessLogoUrl || null,
        businessCity: b.businessCity || (projects.cities[0] || null),
        isVerified: b.verificationStatus?.builder === 'verified',
        verificationStatus: b.verificationStatus?.builder || 'unverified',
        rating: b.rating || 0,
        ratingCount: b.ratingCount || 0,
        lastSeen: b.lastSeen,
        isOnline: b.lastSeen ? b.lastSeen >= fiveMinAgo : false,
        joinedAt: b.createdAt,
        // FOMO stats
        projectCount: projects.count,
        projectLocations: projects.locations,
        agentInterestCount: interestMap[bid] || 0,
        dealsClosedCount: closedMap[bid] || 0,
        newProjectsThisWeek: recentProjectMap[bid] || 0
      };
    });

    // Platform-wide pulse stats
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      totalBuildersOnPlatform,
      onlineBuildersCount,
      activeLeadsToday,
      dealsClosedToday,
      newProjectsToday
    ] = await Promise.all([
      User.countDocuments({ role: 'builder', isActive: true }),
      User.countDocuments({ role: 'builder', isActive: true, lastSeen: { $gte: fiveMinAgo } }),
      ExtractedLead.countDocuments({ createdAt: { $gte: todayStart }, status: { $in: ['auto_detected', 'confirmed'] } }),
      DealRoom.countDocuments({ status: 'closed_won', updatedAt: { $gte: todayStart } }),
      Project.countDocuments({ createdAt: { $gte: todayStart } })
    ]);

    res.status(200).json({
      builders: buildersWithStats,
      total: totalBuilders,
      page: parseInt(page),
      limit: parseInt(limit),
      pulse: {
        totalBuilders: totalBuildersOnPlatform,
        onlineNow: onlineBuildersCount,
        activeLeadsToday,
        dealsClosedToday,
        newProjectsToday
      }
    });
  } catch (err) {
    console.error('getBuildersNetwork error:', err);
    res.status(500).json({ error: err.message });
  }
};
