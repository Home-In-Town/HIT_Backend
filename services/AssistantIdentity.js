/**
 * AssistantIdentity
 *
 * Manages the single reserved "AI Assistant" User document used as the sender
 * of all AI Lead Matching messages. It is a non-human identity:
 *   - flagged with isSystemAssistant: true
 *   - excluded from contact / builder-network listings
 *
 * ensureAssistant() is idempotent — safe to call on every server start.
 */

const User = require('../models/User');
const Logger = require('../utils/logger');

const logger = new Logger('AssistantIdentity');

const ASSISTANT_PHONE = '0000000001'; // reserved, non-dialable placeholder
const ASSISTANT_NAME = 'HIT AI Assistant';

let cachedId = null;

/**
 * Find or create the reserved assistant user. Returns the Mongoose document.
 */
async function ensureAssistant() {
  let assistant = await User.findOne({ isSystemAssistant: true });

  if (!assistant) {
    // Guard against a legacy user occupying the reserved phone.
    assistant = await User.findOne({ phone: ASSISTANT_PHONE });
    if (assistant) {
      assistant.isSystemAssistant = true;
      await assistant.save();
    } else {
      assistant = await User.create({
        name: ASSISTANT_NAME,
        phone: ASSISTANT_PHONE,
        role: 'admin', // internal role; never surfaced as a human contact
        isSystemAssistant: true,
        isVerified: true,
        isActive: true
      });
    }
  }

  cachedId = assistant._id;
  logger.info(`AI Assistant identity ready: ${assistant._id}`);
  return assistant;
}

/**
 * The cached assistant ObjectId (available after ensureAssistant()).
 */
function getAssistantId() {
  return cachedId;
}

/**
 * Look up the assistant id, ensuring it exists if not cached.
 */
async function getAssistantIdAsync() {
  if (cachedId) return cachedId;
  const a = await ensureAssistant();
  return a._id;
}

module.exports = { ensureAssistant, getAssistantId, getAssistantIdAsync, ASSISTANT_NAME };
