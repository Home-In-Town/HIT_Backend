const mongoose = require('mongoose');

const groupRoomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Room type: project-based, builder-based, area-based, or universal (single
  // community group)
  roomType: {
    type: String,
    enum: ['project', 'builder', 'area', 'universal'],
    required: true,
    index: true
  },
  // If project room, link to project.
  // Required whenever roomType === 'project' — a project room with no project
  // link is meaningless and used to be schema-valid (see validate below).
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    default: null,
    validate: {
      validator: function (value) {
        // `this` is the document on save; on update paths it may be the query,
        // in which case we skip (runValidators handles the doc path).
        if (!this || typeof this.get !== 'function') return true;
        if (this.get('roomType') !== 'project') return true;
        return value != null;
      },
      message: 'project is required when roomType is "project"'
    }
  },
  // If builder room, link to the builder (User) whose properties it covers.
  // A builder room is the company-level group: it lists that builder's
  // properties and hosts the conversation with them. Mirrors the `project`
  // guard above so a builder room can never exist without its builder.
  builder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    validate: {
      validator: function (value) {
        if (!this || typeof this.get !== 'function') return true;
        if (this.get('roomType') !== 'builder') return true;
        return value != null;
      },
      message: 'builder is required when roomType is "builder"'
    }
  },
  // If area room, store area metadata
  area: {
    city: { type: String, default: '' },
    location: { type: String, default: '' }
  },
  // Room creator
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Members list
  members: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
    // Last time this member opened the room, used for the unread badge.
    // Deliberately nullable: members who joined before read tracking existed have
    // no value, and unread then falls back to joinedAt. Defaulting this to "now"
    // instead would silently mark every existing room as fully read.
    lastReadAt: { type: Date, default: null }
  }],
  // Room description
  description: { type: String, default: '', maxlength: 500 },
  // Is the room active
  active: { type: Boolean, default: true },
  // Universal room flag — only one universal room exists, auto-joined by all users
  isUniversal: { type: Boolean, default: false },
  // Whether members can leave this room (false for universal)
  canLeave: { type: Boolean, default: true },
  // Auto-created sub-group flag (created by lead matching system)
  isAutoCreated: { type: Boolean, default: false },
  // Last activity timestamp for sorting
  lastActivity: { type: Date, default: Date.now }
}, {
  timestamps: true
});

groupRoomSchema.index({ 'members.user': 1 });
groupRoomSchema.index({ 'area.city': 1, 'area.location': 1 });
groupRoomSchema.index({ project: 1 });
groupRoomSchema.index({ lastActivity: -1 });
groupRoomSchema.index({ isUniversal: 1 }); // Quick lookup for the single universal room

// ── One active group per project (enforced by the database) ──────────────────
// The old code did findOne() then findOneAndUpdate({upsert:true}), which is a
// check-then-act race. An upsert only serialises concurrent writers when a
// unique index backs its filter, and there was none — so two simultaneous
// matches on the same project could each insert a room.
//
// This partial unique index makes a duplicate physically impossible. It is
// scoped to active project rooms so that (a) soft-deleted rooms don't block a
// fresh one, and (b) area/universal rooms (project: null) are unaffected.
//
// NOTE: if duplicates already exist, this index build will fail until they are
// merged. Run `node scripts/backfillProjectGroups.js` first — it merges
// duplicates and then builds the index.
groupRoomSchema.index(
  { project: 1 },
  {
    unique: true,
    partialFilterExpression: { roomType: 'project', active: true },
    name: 'uniq_active_project_room'
  }
);

// ── One active group per builder ─────────────────────────────────────────────
// Same reasoning as the project index above: ensureBuilderGroup is called from
// the project lifecycle and from a backfill, so two concurrent callers could
// otherwise each insert a room for the same builder. Scoped to active builder
// rooms, so soft-deleted rooms don't block a fresh one and rooms of other types
// (builder: null) are unaffected.
groupRoomSchema.index(
  { builder: 1 },
  {
    unique: true,
    partialFilterExpression: { roomType: 'builder', active: true },
    name: 'uniq_active_builder_room'
  }
);

// Builder rooms are listed by builder, so this supports the lookup directly.
groupRoomSchema.index({ builder: 1 });

module.exports = mongoose.model('GroupRoom', groupRoomSchema);
