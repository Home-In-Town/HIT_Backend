const mongoose = require('mongoose');

const groupRoomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Room type: project-based or area-based
  roomType: {
    type: String,
    enum: ['project', 'area'],
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
  // Last activity timestamp for sorting
  lastActivity: { type: Date, default: Date.now }
}, {
  timestamps: true
});

groupRoomSchema.index({ 'members.user': 1 });
groupRoomSchema.index({ 'area.city': 1, 'area.location': 1 });
groupRoomSchema.index({ project: 1 });
groupRoomSchema.index({ lastActivity: -1 });

module.exports = mongoose.model('GroupRoom', groupRoomSchema);
