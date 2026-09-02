/**
 * leadChatController
 *
 * Drives the AI Lead Matching conversation (Approach A — deterministic
 * slot filling, NO LLM). Orchestrates the persistent AI Assistant chat thread:
 *
 *   POST /api/lead-chat/open    → find/create thread, return messages + current question
 *   POST /api/lead-chat/answer  → validate & store answer, return next question or summary
 *   POST /api/lead-chat/edit    → re-open a filled slot for editing
 *   POST /api/lead-chat/confirm → persist ExtractedLead, run matching, notify admins, loop back
 *
 * Everything is scoped to the authenticated user's own thread (derived from
 * req.user — the client never supplies a user id).
 */

const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const ExtractedLead = require('../models/ExtractedLead');
const Notification = require('../models/Notification');
const User = require('../models/User');
const leadFlowEngine = require('../services/LeadFlowEngine');
const locationNormalizer = require('../services/LocationNormalizer');
const matchEngineV2 = require('../services/MatchEngineV2');
const phrasings = require('../config/leadChatPhrasings');
const { getAssistantIdAsync } = require('../services/AssistantIdentity');
const Logger = require('../utils/logger');

const logger = new Logger('LeadChat');

// ─── Message builders ───────────────────────────────────────────────────────

/**
 * Build the (varied) greeting content shown when the thread is first created.
 */
function greetingContent() {
  return phrasings.pickGreeting();
}

/**
 * Localized, intent-aware question text — Hinglish (Hindi) is the primary UX
 * language. Picks a random curated phrasing (via the engine) for the "AI feel".
 *
 * `ackForSlot` (optional): the slot the user JUST answered, plus its display
 * value, so we can occasionally prepend a short acknowledgment ("Perfect.",
 * "Manish Nagar, badhiya area!") inline before the next question (Option A).
 */
function questionContent(slot, intent, ackForSlot, ackValue) {
  const q = leadFlowEngine.questionFor(slot, intent);
  const question = (q && (q.hi || q.en)) || 'Please answer:';

  if (ackForSlot) {
    const ack = phrasings.pickAck(ackForSlot, ackValue);
    if (ack) return `${ack} ${question}`;
  }
  return question;
}

/**
 * Create an assistant (system) question message for a given slot, with the
 * answer-template metadata attached so the frontend can render the control.
 */
async function postQuestion(session, slot, assistantId, user, ack) {
  const flow = session.leadFlowState || {};
  const intent = flow.intent || null;
  const prog = leadFlowEngine.progress(intent, flow.slots || {}, slot.id);

  // Resolve options dynamically (e.g. sell propertyTypeDetailed depends on category).
  const options = (slot.inputType === 'choice' || slot.inputType === 'multichoice')
    ? leadFlowEngine.resolveOptions(slot, flow.slots || {})
    : undefined;
  const template = {
    slotId: slot.id,
    inputType: slot.inputType,
    options,
    unit: slot.unit || [],
    skippable: !!slot.skippable,
    progress: prog
  };

  // Prefill hint for phone from the user's profile.
  if (slot.prefillFromProfile === 'phone' && user && user.phone) {
    template.prefill = user.phone;
  }

  const msg = await ChatMessage.create({
    session: session._id,
    sender: assistantId,
    content: questionContent(slot, intent, ack && ack.slotId, ack && ack.value),
    messageType: 'system',
    template,
    readBy: [assistantId]
  });
  return msg;
}

/**
 * Post the Summary Card message (awaiting confirmation).
 */
async function postSummary(session, assistantId) {
  const flow = session.leadFlowState;
  const summary = leadFlowEngine.buildSummary(flow.intent, flow.slots || {});
  const msg = await ChatMessage.create({
    session: session._id,
    sender: assistantId,
    content: `${phrasings.pickSummaryLead()} ${summary.text}`,
    messageType: 'system',
    template: {
      inputType: 'summary',
      options: { values: summary.values, intent: flow.intent }
    },
    readBy: [assistantId]
  });
  return msg;
}

/**
 * Post a plain assistant text message (e.g., corrective hints, status).
 */
async function postText(session, assistantId, content) {
  return ChatMessage.create({
    session: session._id,
    sender: assistantId,
    content,
    messageType: 'system',
    readBy: [assistantId]
  });
}

/**
 * Advance the conversation: post the next question, or the summary if complete.
 * Mutates and saves session.leadFlowState.currentSlotId / status.
 */
async function advance(session, assistantId, user, ack) {
  const flow = session.leadFlowState;
  const next = leadFlowEngine.nextSlot(flow.intent, flow.slots || {});

  if (!next) {
    flow.status = 'awaiting_confirmation';
    flow.currentSlotId = null;
    session.markModified('leadFlowState');
    await session.save();
    return postSummary(session, assistantId);
  }

  flow.currentSlotId = next.id;
  flow.status = 'in_progress';
  session.markModified('leadFlowState');
  await session.save();
  return postQuestion(session, next, assistantId, user, ack);
}

/**
 * Fresh flow state for a new lead conversation (starts at the intent question).
 */
function freshFlowState() {
  return {
    intent: null,
    slots: {},
    currentSlotId: 'intent',
    editingSlotId: null,
    status: 'in_progress'
  };
}

// ─── Controllers ──────────────────────────────────────────────────────────

/**
 * POST /api/lead-chat/open
 * Find or create the user's single AI Assistant thread. Ensures a greeting +
 * intent question exist for a brand-new thread. Returns messages + flow state.
 */
exports.openAssistantThread = async (req, res) => {
  try {
    const userId = req.user._id;
    const assistantId = await getAssistantIdAsync();

    let session = await ChatSession.findOne({ isAssistant: true, participants: userId });
    let isNew = false;

    if (!session) {
      session = await ChatSession.create({
        participants: [userId, assistantId],
        isAssistant: true,
        leadFlowState: freshFlowState()
      });
      isNew = true;

      // Seed greeting + first (intent) question.
      await postText(session, assistantId, greetingContent());
      const intentSlot = leadFlowEngine.getSlot('intent');
      await postQuestion(session, intentSlot, assistantId, req.user);
    }

    const messages = await ChatMessage.find({ session: session._id, deleted: false })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(isNew ? 201 : 200).json({
      sessionId: session._id,
      isNew,
      flowState: session.leadFlowState,
      messages
    });
  } catch (err) {
    logger.error('openAssistantThread error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/lead-chat/answer  { sessionId, slotId, value }
 * Validate the answer for the current (or editing) slot, store it, and post
 * the next question or the summary.
 */
exports.submitAnswer = async (req, res) => {
  try {
    const userId = req.user._id;
    const assistantId = await getAssistantIdAsync();
    const { sessionId, slotId, value } = req.body || {};

    const session = await ChatSession.findOne({ _id: sessionId, isAssistant: true, participants: userId });
    if (!session) return res.status(404).json({ error: 'Assistant thread not found' });

    const flow = session.leadFlowState || freshFlowState();
    const isEditing = flow.editingSlotId && flow.editingSlotId === slotId;

    // Guard: answer must target the current pending slot (unless it's an edit).
    if (!isEditing && slotId !== flow.currentSlotId) {
      return res.status(400).json({ error: 'This answer does not match the current question.' });
    }

    const slot = leadFlowEngine.getSlot(slotId);
    if (!slot) return res.status(400).json({ error: 'Unknown slot.' });

    const result = leadFlowEngine.parseAndValidate(slot, value, flow.slots || {});
    if (!result.valid) {
      // Re-ask the same slot with a corrective (varied) hint; state unchanged.
      const hint = result.hint || phrasings.pickRetryHint(slot.inputType);
      await postText(session, assistantId, hint);
      const q = await postQuestion(session, slot, assistantId, req.user);
      return res.status(200).json({ valid: false, hint, message: q, flowState: flow });
    }

    // Record the user's answer as a chat message (right-aligned bubble).
    const displayVal = leadFlowEngine.isSkipped(result.value)
      ? 'Skipped'
      : leadFlowEngine._displayValue(slot, result.value, flow.slots || {});
    await ChatMessage.create({
      session: session._id,
      sender: userId,
      content: String(displayVal),
      messageType: 'text',
      readBy: [userId]
    });

    // Store the validated value.
    flow.slots = flow.slots || {};
    flow.slots[slotId] = result.value;

    // Setting the intent starts/keeps the lead conversation.
    if (slotId === 'intent') flow.intent = result.value;

    // Editing a slot may change branching → prune inapplicable answers.
    if (isEditing) {
      flow.slots = leadFlowEngine.pruneInapplicable(flow.intent, flow.slots);
      flow.editingSlotId = null;
    }

    session.leadFlowState = flow;
    session.markModified('leadFlowState');
    await session.save();

    // Occasional inline acknowledgment before the next question (Option A).
    // Only on normal forward flow — not while editing, and not right after the
    // intent choice (nothing meaningful to react to yet).
    const ack = (!isEditing && slotId !== 'intent')
      ? { slotId, value: String(displayVal) }
      : null;

    const message = await advance(session, assistantId, req.user, ack);
    return res.status(200).json({ valid: true, message, flowState: session.leadFlowState });
  } catch (err) {
    logger.error('submitAnswer error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/lead-chat/edit  { sessionId, slotId }
 * Re-open a previously filled slot for editing (from the Summary Card).
 */
exports.editSlot = async (req, res) => {
  try {
    const userId = req.user._id;
    const assistantId = await getAssistantIdAsync();
    const { sessionId, slotId } = req.body || {};

    const session = await ChatSession.findOne({ _id: sessionId, isAssistant: true, participants: userId });
    if (!session) return res.status(404).json({ error: 'Assistant thread not found' });

    const slot = leadFlowEngine.getSlot(slotId);
    if (!slot) return res.status(400).json({ error: 'Unknown slot.' });

    const flow = session.leadFlowState;
    flow.editingSlotId = slotId;
    flow.currentSlotId = slotId;
    flow.status = 'in_progress';
    session.markModified('leadFlowState');
    await session.save();

    const message = await postQuestion(session, slot, assistantId, req.user);
    return res.status(200).json({ message, flowState: session.leadFlowState });
  } catch (err) {
    logger.error('editSlot error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/lead-chat/new  { sessionId }
 * Start a fresh lead conversation on demand (from the "New requirement" action
 * in the closing tray). Resets flow state and posts the intent question.
 * Prior messages are preserved (same persistent thread).
 */
exports.startNewLead = async (req, res) => {
  try {
    const userId = req.user._id;
    const assistantId = await getAssistantIdAsync();
    const { sessionId } = req.body || {};

    const session = await ChatSession.findOne({ _id: sessionId, isAssistant: true, participants: userId });
    if (!session) return res.status(404).json({ error: 'Assistant thread not found' });

    session.leadFlowState = freshFlowState();
    session.markModified('leadFlowState');
    await session.save();

    const intentSlot = leadFlowEngine.getSlot('intent');
    const message = await postQuestion(session, intentSlot, assistantId, req.user);
    return res.status(200).json({ message, flowState: session.leadFlowState });
  } catch (err) {
    logger.error('startNewLead error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/lead-chat/confirm  { sessionId }
 * Persist the ExtractedLead, run matching, notify admins, post results, and
 * loop back to the intent question for the next lead.
 */
exports.confirmLead = async (req, res) => {
  try {
    const userId = req.user._id;
    const assistantId = await getAssistantIdAsync();
    const { sessionId } = req.body || {};

    const session = await ChatSession.findOne({ _id: sessionId, isAssistant: true, participants: userId });
    if (!session) return res.status(404).json({ error: 'Assistant thread not found' });

    const flow = session.leadFlowState;
    if (!flow || !flow.intent || !leadFlowEngine.isComplete(flow.intent, flow.slots || {})) {
      return res.status(400).json({ error: 'Conversation is not complete yet.' });
    }

    // Build lead params from the collected slots.
    const { direction, transactionType, params } = leadFlowEngine.buildLeadParams(flow.intent, flow.slots);

    // Enrich location canonical (controller boundary keeps the engine pure).
    if (params.locationRaw) {
      const norm = locationNormalizer.normalize(params.locationRaw);
      params.locationCanonical = norm.canonical;
    }

    const summary = leadFlowEngine.buildSummary(flow.intent, flow.slots);

    // 1) Persist the lead (never lose data — created before matching).
    let lead;
    try {
      lead = await ExtractedLead.create({
        source: 'direct_chat',
        sourceRoom: session._id,
        sourceRoomModel: 'ChatSession',
        originalText: summary.text,
        extractedBy: userId,
        extractedByRole: req.user.role || 'agent',
        direction,
        params,
        intent: direction === 'sell' || direction === 'rent' ? 'inventory' : 'requirement',
        extractionConfidence: 1,
        paramCount: Object.keys(flow.slots || {}).length,
        status: 'auto_detected'
      });
    } catch (createErr) {
      logger.error('ExtractedLead create failed', { error: createErr.message });
      await postText(session, assistantId, 'Kuch gadbad ho gayi lead save karne me. Dobara confirm karein.');
      return res.status(500).json({ error: 'Failed to save lead. Please retry.' });
    }

    // 2) Run matching (non-fatal on error).
    let matches = [];
    try {
      const excludeId = req.user.role === 'admin' ? null : userId;
      matches = await matchEngineV2.findMatches(params, { limit: 5, excludeOwner: excludeId, minScore: 25 });

      lead.matches = matches.map((m) => ({
        project: m.project._id,
        score: m.score,
        confidence: m.confidence,
        matchedOn: m.matchedOn
      }));
      lead.matchCount = matches.length;
      lead.bestMatchScore = matches[0]?.score || 0;
      await lead.save();
    } catch (matchErr) {
      logger.warn('Matching failed (non-fatal)', { error: matchErr.message });
    }

    // 3) Notify admins (non-fatal).
    try {
      await notifyAdmins(req.user, lead, matches, req.app.get('io'));
    } catch (notifyErr) {
      logger.warn('Admin notify failed (non-fatal)', { error: notifyErr.message });
    }

    // 4) Post results message with match cards.
    const matchCards = matches.map((m) => ({
      projectId: m.project._id,
      projectName: m.project.projectName,
      city: m.project.city,
      location: m.project.location,
      score: m.score,
      slug: m.project.slug
    }));
    const resultsContent = phrasings.pickResults(matches.length);
    const resultsMsg = await ChatMessage.create({
      session: session._id,
      sender: assistantId,
      content: resultsContent,
      messageType: 'system',
      template: { inputType: 'results', options: { leadId: lead._id, matches: matchCards } },
      readBy: [assistantId]
    });

    // 5) Close the flow gracefully — a warm wrap-up + optional quick actions.
    //    We do NOT auto-restart the intent question (that felt pushy). The
    //    conversation enters a terminal 'completed' state with NO pending
    //    question; the user chooses what to do next via the actions tray.
    const closingMsg = await postText(session, assistantId, phrasings.pickClosing());
    const actionsMsg = await ChatMessage.create({
      session: session._id,
      sender: assistantId,
      content: 'Aage kya karna chahenge?',
      messageType: 'system',
      template: {
        inputType: 'actions',
        options: {
          actions: [
            { action: 'new_lead', label: { en: 'New requirement', hi: 'Nayi requirement' }, icon: 'plus' },
            { action: 'view_leads', label: { en: 'View my leads', hi: 'Meri leads dekhein' }, icon: 'list' }
          ]
        }
      },
      readBy: [assistantId]
    });

    flow.status = 'completed';
    flow.currentSlotId = null;
    flow.editingSlotId = null;
    session.markModified('leadFlowState');
    await session.save();

    return res.status(201).json({
      leadId: lead._id,
      matchCount: matches.length,
      resultsMessage: resultsMsg,
      closingMessage: closingMsg,
      actionsMessage: actionsMsg,
      flowState: session.leadFlowState
    });
  } catch (err) {
    logger.error('confirmLead error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Notify all admins of a captured lead (mirrors LeadCaptureService behavior).
 */
async function notifyAdmins(sender, lead, matches, io) {
  const admins = await User.find({ role: 'admin', isActive: true, isSystemAssistant: { $ne: true } })
    .select('_id name')
    .lean();
  if (admins.length === 0) return;

  const adminIds = admins.map((a) => a._id);
  const p = lead.params || {};
  const parts = [];
  if (p.bhkType) parts.push(p.bhkType);
  if (p.propertyType) parts.push(p.propertyType);
  if (p.expectedPrice) parts.push(`${p.expectedPrice}L`);
  if (p.locationRaw) parts.push(p.locationRaw);
  const paramSummary = parts.join(', ') || 'Lead';
  const matchSummary = matches.length > 0 ? `${matches.length} match(es)` : 'No matches yet';

  const title = `AI Lead (${lead.direction}) from ${sender.name} (${sender.role})`;
  const message = `${paramSummary} — ${matchSummary}`;

  await Notification.insertMany(
    adminIds.map((adminId) => ({
      recipient: adminId,
      type: 'lead_match',
      title,
      message,
      reference: { model: 'ExtractedLead', id: lead._id }
    }))
  );

  if (io) {
    for (const admin of admins) {
      io.to(admin._id.toString()).emit('notification', {
        type: 'lead_match',
        title,
        message,
        leadId: lead._id
      });
    }
  }

  await ExtractedLead.findByIdAndUpdate(lead._id, {
    adminNotified: true,
    adminNotifiedAt: new Date(),
    notifiedAdmins: adminIds
  });
}
