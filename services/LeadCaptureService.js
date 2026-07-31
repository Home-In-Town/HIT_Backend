/**
 * LeadCaptureService
 * 
 * Orchestrator that ties everything together:
 *   1. Receives a chat message (text)
 *   2. Runs NLPExtractor to detect requirement intent + extract params
 *   3. If extraction succeeds → runs MatchEngineV2 to find matching projects
 *   4. Persists the ExtractedLead (no data loss)
 *   5. Notifies the sender (agent/captain) of matches via Socket.io
 *   6. Notifies admins of the captured lead
 * 
 * Called from:
 *   - groupChatController.postMessage (REST path)
 *   - groupChat.socket.js (Socket path)
 *   - chat.socket.js (1:1 chat path)
 */

const nlpExtractor = require('./NLPExtractor');
const matchEngineV2 = require('./MatchEngineV2');
const locationNormalizer = require('./LocationNormalizer');
const ExtractedLead = require('../models/ExtractedLead');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Logger = require('../utils/logger');

const logger = new Logger('LeadCapture');

class LeadCaptureService {

  /**
   * Process a chat message for lead extraction and matching.
   * This is the main entry point — call this from controllers/sockets.
   * 
   * @param {object} params
   * @param {string} params.text - The message text
   * @param {object} params.sender - Sender user object { _id, name, role }
   * @param {string} params.source - 'group_chat' or 'direct_chat'
   * @param {string} params.messageId - The saved message's _id
   * @param {string} params.roomId - Group room or chat session _id
   * @param {object} [params.io] - Socket.io instance for real-time notifications
   * @returns {Promise<{ extracted: boolean, lead: object|null, matches: Array }>}
   */
  async processMessage({ text, sender, source, messageId, roomId, io }) {
    const startTime = Date.now();

    try {
      // Quick signal check first (cheap — avoids full extraction on irrelevant messages)
      if (!nlpExtractor.hasRequirementSignal(text)) {
        return { extracted: false, lead: null, matches: [] };
      }

      // Full NLP extraction
      const extraction = nlpExtractor.extract(text, { role: sender.role });
      if (!extraction) {
        return { extracted: false, lead: null, matches: [] };
      }

      logger.info('Requirement detected', {
        sender: sender.name,
        role: sender.role,
        intent: extraction.intent,
        confidence: extraction.confidence,
        params: this._summarizeParams(extraction.params)
      });

      // Enrich location with canonical info
      if (extraction.params.locationRaw) {
        const normalized = locationNormalizer.normalize(extraction.params.locationRaw);
        extraction.params.locationCanonical = normalized.canonical;
        extraction.params.locationConfidence = normalized.confidence;
      }

      // Run MatchEngineV2
      const matches = await matchEngineV2.findMatches(extraction.params, {
        limit: 5,
        excludeOwner: sender._id.toString(),
        minScore: 25
      });

      // Persist the extracted lead (NO DATA LOSS — always save)
      const lead = await this._persistLead({
        extraction,
        sender,
        source,
        messageId,
        roomId,
        matches
      });

      // Notify sender of matches (real-time via Socket.io)
      if (matches.length > 0 && io) {
        this._notifySender(io, sender, lead, matches, roomId, source);
      }

      // Notify admins
      if (extraction.confidence >= 0.5 || matches.length > 0) {
        await this._notifyAdmins(io, sender, lead, matches);
      }

      const elapsed = Date.now() - startTime;
      logger.info(`Lead capture completed in ${elapsed}ms`, {
        leadId: lead._id,
        matchCount: matches.length,
        topScore: matches[0]?.score || 0
      });

      return { extracted: true, lead, matches };

    } catch (err) {
      logger.error('LeadCapture processing error', {
        error: err.message,
        sender: sender?.name,
        text: text?.substring(0, 100)
      });
      // Non-blocking: don't crash the chat flow if lead capture fails
      return { extracted: false, lead: null, matches: [] };
    }
  }

  /**
   * Test extraction only (for debug endpoint) — no DB writes, no notifications
   */
  extractOnly(text) {
    const extraction = nlpExtractor.extract(text);
    if (!extraction) return null;

    // Enrich location
    if (extraction.params.locationRaw) {
      const normalized = locationNormalizer.normalize(extraction.params.locationRaw);
      extraction.params.locationCanonical = normalized.canonical;
      extraction.params.locationConfidence = normalized.confidence;
    }

    return extraction;
  }

  /**
   * Test full match (for debug endpoint) — extraction + matching, no DB write
   */
  async extractAndMatch(text, senderId) {
    const extraction = nlpExtractor.extract(text);
    if (!extraction) return { extraction: null, matches: [] };

    if (extraction.params.locationRaw) {
      const normalized = locationNormalizer.normalize(extraction.params.locationRaw);
      extraction.params.locationCanonical = normalized.canonical;
      extraction.params.locationConfidence = normalized.confidence;
    }

    const matches = await matchEngineV2.findMatches(extraction.params, {
      limit: 5,
      excludeOwner: senderId,
      minScore: 25
    });

    return { extraction, matches };
  }

  // ─── Private: Persist Lead ──────────────────────────────────────────────────

  async _persistLead({ extraction, sender, source, messageId, roomId, matches }) {
    const sourceMessageModel = source === 'group_chat' ? 'GroupMessage' : 'ChatMessage';
    const sourceRoomModel = source === 'group_chat' ? 'GroupRoom' : 'ChatSession';

    const lead = await ExtractedLead.create({
      source,
      sourceMessage: messageId,
      sourceMessageModel,
      sourceRoom: roomId,
      sourceRoomModel,
      originalText: extraction.extractedFrom,
      extractedBy: sender._id,
      extractedByRole: sender.role || 'agent',
      params: {
        bhkType: extraction.params.bhkType,
        budget: extraction.params.budget,
        budgetMax: extraction.params.budgetMax,
        location: extraction.params.location,
        locationRaw: extraction.params.locationRaw,
        locationCanonical: extraction.params.locationCanonical,
        city: extraction.params.city,
        propertyType: extraction.params.propertyType,
        possessionNeeded: extraction.params.possessionNeeded,
        loanRequired: extraction.params.loanRequired || false,
        urgency: extraction.params.urgency || 'normal'
      },
      intent: extraction.intent,
      extractionConfidence: extraction.confidence,
      paramCount: this._countParams(extraction.params),
      matches: matches.map(m => ({
        project: m.project._id,
        score: m.score,
        confidence: m.confidence,
        matchedOn: m.matchedOn
      })),
      matchCount: matches.length,
      bestMatchScore: matches[0]?.score || 0
    });

    return lead;
  }

  // ─── Private: Notify Sender (Agent/Captain) ─────────────────────────────────

  _notifySender(io, sender, lead, matches, roomId, source) {
    const senderId = sender._id.toString();

    // Emit match results to the sender's personal socket room
    io.to(senderId).emit('lead_match_results', {
      leadId: lead._id,
      source,
      roomId,
      extraction: {
        intent: lead.intent,
        confidence: lead.extractionConfidence,
        params: lead.params
      },
      matches: matches.map(m => ({
        project: {
          _id: m.project._id,
          projectName: m.project.projectName,
          city: m.project.city,
          location: m.project.location,
          pricing: m.project.pricing,
          configuration: m.project.configuration,
          owner: m.project.owner,
          slug: m.project.slug,
          media: m.project.media
        },
        score: m.score,
        confidence: m.confidence,
        matchedOn: m.matchedOn
      }))
    });

    // Also emit to the group room so the match card can render inline
    if (source === 'group_chat' && roomId) {
      io.to(`group_${roomId}`).emit('lead_match_inline', {
        leadId: lead._id,
        senderId,
        senderName: sender.name,
        matchCount: matches.length,
        topMatch: matches[0] ? {
          projectName: matches[0].project.projectName,
          score: matches[0].score,
          location: matches[0].project.location
        } : null
      });
    }
  }

  // ─── Private: Notify Admins ─────────────────────────────────────────────────

  async _notifyAdmins(io, sender, lead, matches) {
    try {
      // Find all admin users
      const admins = await User.find({ role: 'admin', isActive: true })
        .select('_id name')
        .lean();

      if (admins.length === 0) return;

      const adminIds = admins.map(a => a._id);

      // Build notification message
      const paramSummary = this._buildParamSummary(lead.params);
      const matchSummary = matches.length > 0
        ? `${matches.length} match${matches.length > 1 ? 'es' : ''} found (top: ${matches[0].score}%)`
        : 'No matches yet';

      const title = `Lead detected from ${sender.name} (${sender.role})`;
      const message = `${paramSummary} — ${matchSummary}`;

      // Create notification for each admin
      const notifications = adminIds.map(adminId => ({
        recipient: adminId,
        type: 'lead_match',
        title,
        message,
        reference: {
          model: 'ExtractedLead',
          id: lead._id
        }
      }));

      await Notification.insertMany(notifications);

      // Real-time push to admin sockets
      if (io) {
        for (const admin of admins) {
          io.to(admin._id.toString()).emit('notification', {
            type: 'lead_match',
            title,
            message,
            leadId: lead._id,
            sender: { name: sender.name, role: sender.role },
            params: lead.params,
            matchCount: matches.length,
            topScore: matches[0]?.score || 0
          });
        }
      }

      // Update lead with notification status
      await ExtractedLead.findByIdAndUpdate(lead._id, {
        adminNotified: true,
        adminNotifiedAt: new Date(),
        notifiedAdmins: adminIds
      });

    } catch (err) {
      logger.error('Admin notification error (non-blocking)', { error: err.message });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _buildParamSummary(params) {
    const parts = [];
    if (params.bhkType) parts.push(params.bhkType);
    if (params.propertyType) parts.push(params.propertyType);
    if (params.budget) {
      parts.push(params.budgetMax
        ? `${params.budget}-${params.budgetMax}L`
        : `${params.budget}L`
      );
    }
    if (params.locationRaw) parts.push(params.locationRaw);
    if (params.city) parts.push(params.city);
    if (params.urgency && params.urgency !== 'normal') parts.push(`[${params.urgency}]`);
    return parts.join(', ') || 'Unknown requirement';
  }

  _summarizeParams(params) {
    const parts = [];
    if (params.bhkType) parts.push(params.bhkType);
    if (params.budget) parts.push(`${params.budget}L`);
    if (params.location) parts.push(params.location);
    return parts.join(' | ');
  }

  _countParams(params) {
    let count = 0;
    if (params.bhkType) count++;
    if (params.budget) count++;
    if (params.location) count++;
    if (params.propertyType) count++;
    if (params.possessionNeeded) count++;
    if (params.loanRequired) count++;
    if (params.city) count++;
    if (params.urgency && params.urgency !== 'normal') count++;
    return count;
  }
}

module.exports = new LeadCaptureService();
