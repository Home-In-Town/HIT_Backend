const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const matchEngine = require('../services/MatchEngine');
const leadCaptureService = require('../services/LeadCaptureService');

/**
 * Group Chat Socket Handler
 * Handles real-time group messaging, typing indicators, and match notifications
 *
 * This is attached to the same io instance as the main chat socket.
 * Events are namespaced with 'group_' prefix to avoid conflicts.
 */
module.exports = (io) => {
  io.on('connection', (socket) => {
    if (!socket.user) return; // Auth handled by main chat socket middleware

    const userId = socket.user._id.toString();

    // ═══════════════════════════════════════════════════════
    // GROUP ROOM EVENTS
    // ═══════════════════════════════════════════════════════

    /**
     * Join a group room's socket channel
     */
    socket.on('join_group', async (roomId) => {
      try {
        // Verify membership
        const room = await GroupRoom.findOne({
          _id: roomId,
          'members.user': socket.user._id,
          active: true
        });

        if (!room) {
          socket.emit('error', { message: 'Not a member of this group' });
          return;
        }

        socket.join(`group_${roomId}`);
        console.log(`📢 ${socket.user.name} joined group: ${room.name}`);

        // Notify others in the room
        socket.to(`group_${roomId}`).emit('group_user_online', {
          userId,
          name: socket.user.name,
          role: socket.user.role
        });
      } catch (err) {
        console.error('join_group error:', err.message);
        socket.emit('error', { message: 'Failed to join group' });
      }
    });

    /**
     * Leave a group room's socket channel
     */
    socket.on('leave_group', (roomId) => {
      socket.leave(`group_${roomId}`);
      socket.to(`group_${roomId}`).emit('group_user_offline', {
        userId,
        name: socket.user.name
      });
    });

    /**
     * Send a message in a group room (real-time path)
     * Supports: text, inventory_card, requirement_card
     */
    socket.on('group_send_message', async (data) => {
      try {
        const { roomId, messageType, content, inventoryCard, requirementCard } = data;

        if (!roomId) {
          socket.emit('error', { message: 'roomId is required' });
          return;
        }

        // Verify membership
        const room = await GroupRoom.findOne({
          _id: roomId,
          'members.user': socket.user._id,
          active: true
        });

        if (!room) {
          socket.emit('error', { message: 'Not authorized' });
          return;
        }

        // Role check for card types
        if (messageType === 'inventory_card' && socket.user.role !== 'builder' && socket.user.role !== 'admin') {
          socket.emit('error', { message: 'Only builders can post inventory cards' });
          return;
        }
        if (messageType === 'requirement_card' && socket.user.role !== 'agent' && socket.user.role !== 'admin') {
          socket.emit('error', { message: 'Only agents can post requirement cards' });
          return;
        }

        // Save message
        const msgData = {
          room: roomId,
          sender: socket.user._id,
          messageType: messageType || 'text',
          content: content || ''
        };

        if (messageType === 'inventory_card' && inventoryCard) {
          msgData.inventoryCard = inventoryCard;
        }
        if (messageType === 'requirement_card' && requirementCard) {
          msgData.requirementCard = requirementCard;
        }

        const message = await GroupMessage.create(msgData);

        // Run auto-match for requirement cards
        let matches = [];
        if (messageType === 'requirement_card' && requirementCard) {
          matches = await matchEngine.findMatches(requirementCard, {
            limit: 5,
            excludeOwner: socket.user._id
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

        // Update room activity
        room.lastActivity = new Date();
        await room.save();

        // Populate for broadcast
        await message.populate('sender', 'name role companyName');
        await message.populate('inventoryCard.project', 'projectName slug media');
        await message.populate('matchResults.project', 'projectName city location pricing configuration owner slug media');

        const msgObj = message.toObject();

        // Broadcast to everyone in the group room
        io.to(`group_${roomId}`).emit('group_message', {
          ...msgObj,
          roomId
        });

        // If matches found, send dedicated match event to the posting agent
        if (matches.length > 0) {
          socket.emit('match_results', {
            messageId: message._id,
            roomId,
            matches: matches.map(m => ({
              project: m.project,
              score: m.score,
              matchedOn: m.matchedOn
            }))
          });
        }

        // === NLP LEAD CAPTURE for text messages ===
        // Detects requirement intent in free text, runs matching, notifies admin
        if (messageType === 'text' && content && content.length >= 10) {
          leadCaptureService.processMessage({
            text: content,
            sender: { _id: socket.user._id, name: socket.user.name, role: socket.user.role },
            source: 'group_chat',
            messageId: message._id,
            roomId,
            io
          }).catch(err => {
            console.error('LeadCapture (Socket) non-blocking error:', err.message);
          });
        }

      } catch (err) {
        console.error('group_send_message error:', err.message);
        socket.emit('error', { message: 'Failed to send group message' });
      }
    });

    /**
     * Typing indicator in group
     */
    socket.on('group_typing', (data) => {
      const { roomId, isTyping } = data;
      socket.to(`group_${roomId}`).emit('group_user_typing', {
        userId,
        name: socket.user.name,
        isTyping
      });
    });
  });
};
