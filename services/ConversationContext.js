/**
 * ConversationContext Service
 * 
 * Tracks recent requirement extractions per user and per room,
 * enabling follow-up message resolution.
 * 
 * When an agent says: "same area but 3bhk" — this service provides
 * the previous extraction params so NLPExtractor can resolve the reference.
 * 
 * Storage: In-memory with TTL (30 minutes per context entry).
 * This is intentionally ephemeral — not persisted to DB.
 * If the server restarts, context resets (acceptable trade-off).
 */

const Logger = require('../utils/logger');
const logger = new Logger('ConversationContext');

const CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES_PER_KEY = 5;          // Keep last 5 extractions per key
const MAX_TOTAL_KEYS = 2000;            // Max unique user/room keys

class ConversationContext {
  constructor() {
    // Map<string, Array<{ params, timestamp, text }>>
    this._store = new Map();
  }

  /**
   * Store an extraction result in context.
   * Called after successful extraction by LeadCaptureService.
   * 
   * @param {string} userId - The user who sent the message
   * @param {string} roomId - The room where the message was sent
   * @param {object} params - The extracted params
   * @param {string} text - Original message text
   */
  store(userId, roomId, params, text) {
    const userKey = `user:${userId}`;
    const roomKey = `room:${roomId}:${userId}`;

    const entry = {
      params: { ...params },
      timestamp: Date.now(),
      text: text?.substring(0, 200) || ''
    };

    this._addToKey(userKey, entry);
    this._addToKey(roomKey, entry);

    // Evict if too many total keys
    if (this._store.size > MAX_TOTAL_KEYS) {
      this._evictOldest();
    }
  }

  /**
   * Get the most recent extraction params for a user in a room.
   * Used by NLPExtractor to resolve follow-up references.
   * 
   * @param {string} userId
   * @param {string} roomId
   * @returns {object|null} - Previous params or null
   */
  getLatest(userId, roomId) {
    // Prefer room-specific context
    const roomKey = `room:${roomId}:${userId}`;
    const roomEntries = this._store.get(roomKey);
    if (roomEntries && roomEntries.length > 0) {
      const latest = roomEntries[roomEntries.length - 1];
      if (Date.now() - latest.timestamp < CONTEXT_TTL_MS) {
        return latest.params;
      }
    }

    // Fallback to user-level context (any room)
    const userKey = `user:${userId}`;
    const userEntries = this._store.get(userKey);
    if (userEntries && userEntries.length > 0) {
      const latest = userEntries[userEntries.length - 1];
      if (Date.now() - latest.timestamp < CONTEXT_TTL_MS) {
        return latest.params;
      }
    }

    return null;
  }

  /**
   * Get recent extraction history for a user (last N extractions).
   * Useful for admin dashboard — shows conversation thread of requirements.
   * 
   * @param {string} userId
   * @param {number} limit
   * @returns {Array<{ params, timestamp, text }>}
   */
  getHistory(userId, limit = 5) {
    const userKey = `user:${userId}`;
    const entries = this._store.get(userKey) || [];
    return entries
      .filter(e => Date.now() - e.timestamp < CONTEXT_TTL_MS)
      .slice(-limit);
  }

  /**
   * Clear context for a user (e.g., when they start a new requirement thread).
   */
  clear(userId, roomId) {
    if (roomId) {
      this._store.delete(`room:${roomId}:${userId}`);
    }
    this._store.delete(`user:${userId}`);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  _addToKey(key, entry) {
    if (!this._store.has(key)) {
      this._store.set(key, []);
    }
    const entries = this._store.get(key);
    entries.push(entry);

    // Keep only recent entries
    if (entries.length > MAX_ENTRIES_PER_KEY) {
      entries.shift(); // Remove oldest
    }

    // Clean expired entries
    const now = Date.now();
    const valid = entries.filter(e => now - e.timestamp < CONTEXT_TTL_MS);
    this._store.set(key, valid);
  }

  _evictOldest() {
    // Remove keys with all expired entries, or oldest keys
    const now = Date.now();
    for (const [key, entries] of this._store.entries()) {
      const valid = entries.filter(e => now - e.timestamp < CONTEXT_TTL_MS);
      if (valid.length === 0) {
        this._store.delete(key);
      } else {
        this._store.set(key, valid);
      }
    }

    // If still too large, remove oldest keys
    if (this._store.size > MAX_TOTAL_KEYS) {
      const keysToRemove = this._store.size - MAX_TOTAL_KEYS + 100; // Remove 100 extra buffer
      let removed = 0;
      for (const key of this._store.keys()) {
        if (removed >= keysToRemove) break;
        this._store.delete(key);
        removed++;
      }
    }
  }

  /**
   * Get stats for monitoring.
   */
  getStats() {
    let totalEntries = 0;
    for (const entries of this._store.values()) {
      totalEntries += entries.length;
    }
    return {
      totalKeys: this._store.size,
      totalEntries,
      maxKeys: MAX_TOTAL_KEYS,
      ttlMinutes: CONTEXT_TTL_MS / 60000
    };
  }
}

module.exports = new ConversationContext();
