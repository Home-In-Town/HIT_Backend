/**
 * Migration Script: Add all existing users to the Universal Group ("HIT Community")
 * 
 * Run once after deploying the universal group feature.
 * Safe to run multiple times — skips users already in the group.
 * 
 * Usage: node scripts/migrate-universal-group.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const GroupRoom = require('../models/GroupRoom');

async function migrate() {
  console.log('🔄 Connecting to database...');
  await connectDB();

  // Find or create the universal group
  let room = await GroupRoom.findOne({ isUniversal: true, active: true });

  if (!room) {
    // Create it
    const admin = await User.findOne({ role: 'admin' }).select('_id');
    if (!admin) {
      console.error('❌ No admin user found. Cannot create universal group.');
      process.exit(1);
    }

    room = await GroupRoom.create({
      name: 'HIT Community',
      roomType: 'universal',
      createdBy: admin._id,
      description: 'The official HIT Community group. All platform members are here. Post requirements and inventory to find matches.',
      members: [{ user: admin._id, role: 'admin' }],
      isUniversal: true,
      canLeave: false,
      active: true,
      lastActivity: new Date()
    });
    console.log(`✅ Created "HIT Community" group: ${room._id}`);
  } else {
    console.log(`✅ Found existing "HIT Community" group: ${room._id} (${room.members.length} current members)`);
  }

  // Get all active, verified users
  const users = await User.find({ isActive: true, isVerified: true }).select('_id name role');
  console.log(`📋 Found ${users.length} active verified users`);

  // Get existing member IDs for quick lookup
  const existingMemberIds = new Set(room.members.map(m => m.user.toString()));
  console.log(`📋 Already ${existingMemberIds.size} members in group`);

  // Find users not yet in the group
  const newMembers = users.filter(u => !existingMemberIds.has(u._id.toString()));
  console.log(`➕ ${newMembers.length} users to add`);

  if (newMembers.length === 0) {
    console.log('✅ All users are already in the universal group. Nothing to do.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Batch add (push all at once for performance)
  const memberDocs = newMembers.map(u => ({
    user: u._id,
    role: 'member',
    joinedAt: new Date()
  }));

  room.members.push(...memberDocs);
  await room.save();

  console.log(`✅ Added ${newMembers.length} users to "HIT Community"`);
  console.log(`📊 Total members now: ${room.members.length}`);

  // Summary by role
  const roleCounts = {};
  newMembers.forEach(u => {
    roleCounts[u.role] = (roleCounts[u.role] || 0) + 1;
  });
  console.log('📊 Breakdown:', roleCounts);

  await mongoose.disconnect();
  console.log('🎉 Migration complete!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
