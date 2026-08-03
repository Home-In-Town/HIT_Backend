require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Project = require('../models/Project');

async function run() {
  await connectDB();

  const admins = await User.find({ role: 'admin', isActive: true }).select('_id name phone').lean();
  console.log('Admin users:');
  admins.forEach(a => console.log(`  ${a._id} | ${a.name} | ${a.phone}`));

  const skyline = await Project.findOne({ projectName: /skyline/i }).select('owner projectName').lean();
  console.log('\nSkyline owner:', skyline?.owner?.toString());

  // Check if admin owns the Skyline project
  const adminOwnsIt = admins.some(a => a._id.toString() === skyline?.owner?.toString());
  console.log('Admin owns Skyline?', adminOwnsIt);

  // Find who owns it
  const owner = await User.findById(skyline?.owner).select('_id name role phone').lean();
  console.log('Skyline owner details:', owner);

  await mongoose.disconnect();
}
run();
