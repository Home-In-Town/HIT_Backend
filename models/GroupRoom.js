const mongoose = require('mongoose');

const groupRoomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Room type: project-based, area-based, or universal (single community group)
  roomType: {
    type: String,
    enum: ['project', 'area', 'universal'],
    required: true,
    index: true
  },
  // If project room, link to project
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    default: null
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
    joinedAt: { type: Date, default: Date.now }
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

module.exports = mongoose.model('GroupRoom', groupRoomSchema);
