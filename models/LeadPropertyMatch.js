const mongoose = require('mongoose');

/**
 * LeadPropertyMatch
 *
 * The single source of truth for "this lead matches this property".
 *
 * WHY THIS COLLECTION EXISTS
 * Before this, match results were stored as an embedded array on the lead
 * (`ExtractedLead.matches`). That worked for display but could not satisfy two
 * product requirements:
 *
 *   1. "avoid duplicate matches/notifications"
 *      The embedded array was de-duplicated by hand in one place
 *      (ReverseMatchService._updateLeadsWithReverseMatch) and not at all in the
 *      others. Nothing anywhere tracked whether a *notification* had already
 *      gone out, so re-publishing or editing a project re-notified the same
 *      agent about the same project. Here the unique index makes duplicate
 *      pairs impossible at the database level rather than by convention, and
 *      `notifiedUsers` makes notification delivery idempotent per recipient.
 *
 *   2. "maintain a correct Lead → Property relationship using stable IDs"
 *      A first-class document with `lead` + `project` ObjectIds is queryable
 *      from both directions (all properties for a lead, all leads for a
 *      property) and survives independently of either side's shape.
 *
 * It is deliberately polymorphic over the lead type so the human-created CRM
 * lead (HumanLead) and the chat-captured lead (ExtractedLead) share one
 * relationship table and one dedupe guarantee.
 */
const leadPropertyMatchSchema = new mongoose.Schema({
  // ── The two stable IDs this record relates ──
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'leadModel',
    index: true,
  },
  // Which collection `lead` points at. Drives refPath population.
  leadModel: {
    type: String,
    required: true,
    enum: ['HumanLead', 'ExtractedLead'],
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true,
  },

  // ── Match quality, as returned by the engine ──
  // Kept in sync with MatchEngineV2's contract so nothing has to be recomputed
  // at read time.
  score: { type: Number, required: true, min: 0, max: 100 },
  confidence: { type: Number, min: 0, max: 1, default: null },
  matchedOn: { type: [String], default: [] },
  matchQuality: {
    type: String,
    enum: ['exact', 'close', 'nearest'],
    default: 'close',
  },

  // How this pair was discovered. Purely for audit/debugging — it tells you
  // whether a match came from the agent qualifying the lead, from a project
  // being published later, or from a manual re-run.
  matchSource: {
    type: String,
    enum: ['qualification', 'project_published', 'manual_rematch'],
    default: 'qualification',
  },

  // ── Lifecycle ──
  // firstMatchedAt is written once, on insert, and never moves. lastScoredAt
  // updates on every re-score, so you can see a pair was re-evaluated without
  // losing when it was originally found.
  firstMatchedAt: { type: Date, default: Date.now },
  lastScoredAt: { type: Date, default: Date.now },

  // Users who have already been told about this specific pair. Checked before
  // sending so a re-publish or re-match never re-notifies.
  // Notification delivery itself is not built yet; this field exists now so it
  // can be layered on without a migration or a rework of the dedupe logic.
  notifiedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],

  // An agent can dismiss a bad match. Dismissed pairs are excluded from reads
  // and never re-notified, but the row is kept so re-scoring does not silently
  // resurrect them.
  dismissed: { type: Boolean, default: false },
  dismissedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  dismissedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

// ─── Indexes ─────────────────────────────────────────────────────────────────

// THE important one: one row per (lead, project) pair, enforced by the database.
// This is what makes repeated match runs idempotent and duplicate matches
// structurally impossible.
leadPropertyMatchSchema.index(
  { leadModel: 1, lead: 1, project: 1 },
  { unique: true }
);

// Read path: "show me this lead's matches, best first".
leadPropertyMatchSchema.index({ leadModel: 1, lead: 1, dismissed: 1, score: -1 });

// Reverse read path: "which leads matched this project".
leadPropertyMatchSchema.index({ project: 1, dismissed: 1, score: -1 });

// ─── Statics ─────────────────────────────────────────────────────────────────

/**
 * Idempotently record a (lead, project) match.
 *
 * The insert-vs-update distinction is the whole point of this collection, so it
 * lives here in one place rather than being re-implemented by every caller:
 *   - a brand-new pair is inserted and reported as new (callers notify on these)
 *   - an existing pair has its score refreshed and is reported as not new
 *     (callers stay silent, which is what prevents duplicate notifications)
 *
 * `firstMatchedAt` is only written via $setOnInsert so re-scoring cannot move it.
 *
 * Uses `new: false` rather than driver result metadata because the option name
 * for that has changed across mongoose majors; a null return unambiguously
 * means "did not exist before".
 *
 * @returns {Promise<{ isNew: boolean, previous: object|null }>}
 */
leadPropertyMatchSchema.statics.recordMatch = async function recordMatch({
  lead,
  leadModel,
  project,
  score,
  confidence = null,
  matchedOn = [],
  matchQuality = 'close',
  matchSource = 'qualification',
}) {
  const filter = { leadModel, lead, project };

  const previous = await this.findOneAndUpdate(
    filter,
    {
      $set: {
        score,
        confidence,
        matchedOn,
        matchQuality,
        matchSource,
        lastScoredAt: new Date(),
      },
      $setOnInsert: {
        firstMatchedAt: new Date(),
        notifiedUsers: [],
        dismissed: false,
      },
    },
    { upsert: true, new: false }
  ).lean();

  return { isNew: previous === null, previous };
};

/**
 * Mark a pair as notified for a specific user. $addToSet keeps this safe to
 * call repeatedly. Returns true only when this user had NOT been notified
 * before, so the caller can decide whether to actually send anything.
 */
leadPropertyMatchSchema.statics.markNotified = async function markNotified(matchId, userId) {
  const res = await this.updateOne(
    { _id: matchId, notifiedUsers: { $ne: userId } },
    { $addToSet: { notifiedUsers: userId } }
  );
  return res.modifiedCount > 0;
};

module.exports = mongoose.model('LeadPropertyMatch', leadPropertyMatchSchema);
