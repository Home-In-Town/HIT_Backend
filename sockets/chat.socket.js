const jwt = require('jsonwebtoken');
const ChatMessage = require('../models/ChatMessage');
const ChatSession = require('../models/ChatSession');
const User = require('../models/User');

/**
 * Socket.io chat handler
 * Handles real-time messaging, typing indicators, and user presence
 */
module.exports = (io) => {
  // Auth middleware for socket connections
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token ||
                    socket.handshake.headers?.cookie?.split('token=')[1]?.split(';')[0];

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-mpin');

      if (!user || !user.isActive) {
        return next(new Error('User not found or inactive'));
      }

      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user._id.toString();
    console.log(`🟢 Socket connected: ${socket.user.name} (${userId})`);

    // Join personal room for notifications
    socket.join(userId);

    // ========== CHAT EVENTS ==========

    /**
     * Join a specific chat session room
     */
    socket.on('join_chat', async (sessionId) => {
      try {
        // Verify user is a participant
        const session = await ChatSession.findOne({
          _id: sessionId,
          participants: socket.user._id
        });

        if (!session) {
          socket.emit('error', { message: 'Not authorized for this chat session' });
          return;
        }

        socket.join(sessionId);
        console.log(`💬 ${socket.user.name} joined chat: ${sessionId}`);

        // Notify other participants
        socket.to(sessionId).emit('user_joined', {
          userId,
          name: socket.user.name
        });
      } catch (err) {
        console.error('join_chat error:', err.message);
        socket.emit('error', { message: 'Failed to join chat' });
      }
    });

    /**
     * Leave a chat session room
     */
    socket.on('leave_chat', (sessionId) => {
      socket.leave(sessionId);
      socket.to(sessionId).emit('user_left', {
        userId,
        name: socket.user.name
      });
    });

    /**
     * Send a message in a chat session
     */
    socket.on('send_message', async (data) => {
      try {
        const { sessionId, content, messageType, attachment } = data;

        if (!sessionId || !content) {
          socket.emit('error', { message: 'sessionId and content are required' });
          return;
        }

        // Verify participation
        const session = await ChatSession.findOne({
          _id: sessionId,
          participants: socket.user._id
        });

        if (!session) {
          socket.emit('error', { message: 'Not authorized' });
          return;
        }

        // Save message to DB
        const message = await ChatMessage.create({
          session: sessionId,
          sender: socket.user._id,
          content,
          messageType: messageType || 'text',
          attachment: attachment || undefined,
          readBy: [socket.user._id] // Sender has read their own message
        });

        // Populate sender info
        await message.populate('sender', 'name role');

        // Update session's last message
        session.lastMessage = {
          content: content.substring(0, 100),
          sender: socket.user._id,
          timestamp: new Date()
        };

        // Increment unread for other participants
        for (const participantId of session.participants) {
          const pid = participantId.toString();
          if (pid !== userId) {
            const current = session.unreadCount?.get(pid) || 0;
            session.unreadCount.set(pid, current + 1);
          }
        }

        await session.save();

        // Broadcast message to all in the session room
        io.to(sessionId).emit('receive_message', {
          _id: message._id,
          session: sessionId,
          sender: { _id: socket.user._id, name: socket.user.name, role: socket.user.role },
          content: message.content,
          messageType: message.messageType,
          attachment: message.attachment,
          createdAt: message.createdAt
        });

        // Send notification to offline participants via their personal room
        for (const participantId of session.participants) {
          const pid = participantId.toString();
          if (pid !== userId) {
            io.to(pid).emit('notification', {
              type: 'new_chat_message',
              title: `New message from ${socket.user.name}`,
              message: content.substring(0, 80),
              sessionId
            });
          }
        }

      } catch (err) {
        console.error('send_message error:', err.message);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    /**
     * Typing indicator
     */
    socket.on('typing', (data) => {
      const { sessionId, isTyping } = data;
      socket.to(sessionId).emit('user_typing', {
        userId,
        name: socket.user.name,
        isTyping
      });
    });

    /**
     * Mark messages as read
     */
    socket.on('mark_read', async (data) => {
      try {
        const { sessionId } = data;

        await ChatMessage.updateMany(
          {
            session: sessionId,
            sender: { $ne: socket.user._id },
            readBy: { $nin: [socket.user._id] }
          },
          { $addToSet: { readBy: socket.user._id } }
        );

        // Reset unread count
        const session = await ChatSession.findById(sessionId);
        if (session?.unreadCount) {
          session.unreadCount.set(userId, 0);
          await session.save();
        }

        socket.to(sessionId).emit('messages_read', { userId });
      } catch (err) {
        console.error('mark_read error:', err.message);
      }
    });

    // ========== DISCONNECT ==========

    socket.on('disconnect', () => {
      console.log(`🔴 Socket disconnected: ${socket.user.name} (${userId})`);
    });
  });
};
