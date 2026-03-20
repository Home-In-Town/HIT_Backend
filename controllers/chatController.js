const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const Notification = require('../models/Notification');
const User = require('../models/User');

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
        .populate('participants', 'name phone role companyName')
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
      .populate('participants', 'name phone role companyName')
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
      .populate('participants', 'name phone role companyName')
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
      .select('name phone role companyName')
      .sort({ name: 1 })
      .limit(100);

    res.status(200).json({ contacts });
  } catch (err) {
    console.error('getContacts error:', err);
    res.status(500).json({ error: err.message });
  }
};
