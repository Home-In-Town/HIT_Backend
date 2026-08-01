require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8','8.8.4.4','1.1.1.1']);
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Project = require('../models/Project');

async function check() {
  await connectDB();

  // Search for any project with 'manish' in location
  const manishProjects = await Project.find({
    status: 'published',
    $or: [
      { location: { $regex: /manish/i } },
      { city: { $regex: /manish/i } }
    ]
  }).select('projectName location city pricing.startingPrice configuration.bhkOptions projectStatus').lean();

  console.log('\n=== Projects with "Manish Nagar" in location ===');
  console.log('Found:', manishProjects.length);
  manishProjects.forEach(p => {
    console.log('  -', p.projectName, '|', p.location, '|', (p.pricing?.startingPrice/100000)+'L', '|', p.configuration?.bhkOptions?.join(','));
  });

  // 2BHK projects in 60-70L range anywhere
  const budgetMatch = await Project.find({
    status: 'published',
    'pricing.startingPrice': { $gte: 6000000, $lte: 7000000 },
    'configuration.bhkOptions': { $regex: /2/i }
  }).select('projectName location city pricing.startingPrice configuration.bhkOptions').lean();

  console.log('\n=== 2BHK projects in 60-70L range (any location) ===');
  console.log('Found:', budgetMatch.length);
  budgetMatch.forEach(p => {
    console.log('  -', p.projectName, '|', p.location, '|', (p.pricing?.startingPrice/100000)+'L', '|', p.configuration?.bhkOptions?.join(','));
  });

  // All published projects
  const allPublished = await Project.find({ status: 'published' })
    .select('projectName location city pricing.startingPrice configuration.bhkOptions')
    .sort({ 'pricing.startingPrice': 1 })
    .lean();

  console.log('\n=== ALL Published Projects (sorted by price) ===');
  console.log('Total:', allPublished.length);
  allPublished.forEach(p => {
    const price = p.pricing?.startingPrice ? (p.pricing.startingPrice/100000).toFixed(0) + 'L' : 'N/A';
    const bhk = (p.configuration?.bhkOptions || []).join(', ') || 'N/A';
    console.log(`  - ${(p.projectName||'?').padEnd(28)} | ${(p.location||p.city||'-').padEnd(22)} | ${price.padStart(6)} | ${bhk}`);
  });

  await mongoose.disconnect();
}
check();
