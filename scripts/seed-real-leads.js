/**
 * Seed Real Lead Data for Frontend Testing
 * 
 * This script:
 *   1. Finds your REAL admin, agents, builders from the DB (no new users created)
 *   2. Finds existing published projects
 *   3. Creates realistic ExtractedLead documents that will show up in the admin UI
 *   4. Covers best-to-worst scenarios: perfect matches, partial matches, no matches,
 *      different confidence levels, different statuses, different locations
 * 
 * Prerequisites:
 *   - MongoDB connection working
 *   - At least 1 admin, 1 agent/captain, and some published projects in the DB
 * 
 * Usage:
 *   node scripts/seed-real-leads.js
 * 
 * To clear seeded data:
 *   node scripts/seed-real-leads.js --clean
 */

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Project = require('../models/Project');
const ExtractedLead = require('../models/ExtractedLead');
const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const Notification = require('../models/Notification');

const SEED_TAG = '[SEED-TEST]'; // Tag to identify seeded data for cleanup

async function main() {
  try {
    await connectDB();
    console.log('Connected to MongoDB\n');

    // Handle --clean flag
    if (process.argv.includes('--clean')) {
      await cleanup();
      await mongoose.disconnect();
      process.exit(0);
    }

    // Step 1: Find real users
    console.log('Finding real users...');
    const admin = await User.findOne({ role: 'admin', isActive: true }).lean();
    const agents = await User.find({ role: { $in: ['agent', 'captain'] }, isActive: true }).limit(5).lean();
    const builders = await User.find({ role: 'builder', isActive: true }).limit(3).lean();

    if (!admin) { console.error('No admin user found!'); process.exit(1); }
    if (agents.length === 0) { console.error('No agents found!'); process.exit(1); }

    console.log(`  Admin: ${admin.name} (${admin.phone})`);
    console.log(`  Agents/Captains: ${agents.map(a => a.name).join(', ')}`);
    console.log(`  Builders: ${builders.map(b => b.name).join(', ')}`);

    // Step 2: Find real published projects
    const projects = await Project.find({ status: 'published' })
      .select('projectName city location pricing configuration projectStatus reraApproved')
      .limit(10).lean();

    console.log(`  Published Projects: ${projects.length}`);
    if (projects.length > 0) {
      projects.slice(0, 5).forEach(p => {
        console.log(`    - ${p.projectName} | ${p.location || p.city} | ${p.pricing?.startingPrice ? (p.pricing.startingPrice/100000).toFixed(0)+'L' : 'N/A'}`);
      });
    }
    console.log('');

    // Step 3: Find or create a group room for context
    let groupRoom = await GroupRoom.findOne({ active: true }).lean();
    if (!groupRoom) {
      groupRoom = await GroupRoom.create({
        name: 'Nagpur Real Estate Hub', roomType: 'area',
        area: { city: 'Nagpur', location: 'All Areas' },
        createdBy: admin._id,
        members: [{ user: admin._id, role: 'admin' }, ...agents.map(a => ({ user: a._id, role: 'member' }))],
        lastActivity: new Date()
      });
      console.log('Created group room: Nagpur Real Estate Hub');
    }

    // Step 4: Clean previous seeded data
    await ExtractedLead.deleteMany({ originalText: { $regex: /^\[SEED-TEST\]/ } });
    await Notification.deleteMany({ title: { $regex: /^\[SEED-TEST\]/ } });
    console.log('Cleaned previous seed data\n');

    // Step 5: Create realistic leads covering all scenarios
    console.log('Creating test leads...\n');
    const leads = await createTestLeads(agents, projects, groupRoom);
    
    // Step 6: Create admin notifications
    await createAdminNotifications(admin, leads, agents);

    console.log('\n All done! Open your frontend at /dashboard/group-chat');
    console.log('   Switch to the "Leads" tab to see the seeded data.');
    console.log('   Switch to the "Stats" tab for metrics.\n');
    console.log('   To clean up: node scripts/seed-real-leads.js --clean\n');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

async function createTestLeads(agents, projects, groupRoom) {
  const now = Date.now();
  const createdLeads = [];

  // Helper to pick a random agent
  const pickAgent = (idx) => agents[idx % agents.length];
  const pickProject = (idx) => projects.length > 0 ? projects[idx % projects.length] : null;

  const scenarios = [
    // ══════════ BEST CASE: High confidence, perfect match ══════════
    {
      originalText: `${SEED_TAG} I need 2bhk flat near Manish Nagar 60 lakh budget loan required urgent`,
      agentIdx: 0,
      params: { bhkType: '2BHK', budget: 60, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', locationCanonical: 'manish_nagar', city: 'Nagpur', propertyType: 'flat', possessionNeeded: null, loanRequired: true, urgency: 'urgent' },
      intent: 'requirement', confidence: 0.95, paramCount: 6,
      status: 'auto_detected', matchProjectIdx: 0, matchScore: 93,
      createdAgo: 5 * 60000 // 5 minutes ago
    },
    {
      originalText: `${SEED_TAG} client wants 3bhk villa in Pratap Nagar 1.2cr ready possession`,
      agentIdx: 1,
      params: { bhkType: '3BHK', budget: 120, budgetMax: null, location: 'pratap_nagar', locationRaw: 'Pratap Nagar', locationCanonical: 'pratap_nagar', city: 'Nagpur', propertyType: 'villa', possessionNeeded: 'immediate', loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.92, paramCount: 5,
      status: 'auto_detected', matchProjectIdx: 1, matchScore: 85,
      createdAgo: 15 * 60000
    },
    {
      originalText: `${SEED_TAG} looking for 2bhk flat near Wardha Road 55-65 lakh bank loan needed`,
      agentIdx: 0,
      params: { bhkType: '2BHK', budget: 55, budgetMax: 65, location: 'wardha_road', locationRaw: 'near Wardha Road', locationCanonical: 'wardha_road', city: 'Nagpur', propertyType: 'flat', possessionNeeded: null, loanRequired: true, urgency: 'normal' },
      intent: 'requirement', confidence: 0.90, paramCount: 5,
      status: 'confirmed', matchProjectIdx: 2, matchScore: 78,
      createdAgo: 45 * 60000
    },

    // ══════════ GOOD CASE: Medium confidence, partial match ══════════
    {
      originalText: `${SEED_TAG} 2bhk chahiye Besa mein around 50L negotiable`,
      agentIdx: 2 % agents.length,
      params: { bhkType: '2BHK', budget: 45, budgetMax: 55, location: 'besa', locationRaw: 'Besa', locationCanonical: 'besa', city: 'Nagpur', propertyType: null, possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.78, paramCount: 3,
      status: 'auto_detected', matchProjectIdx: 3 % projects.length, matchScore: 62,
      createdAgo: 2 * 3600000 // 2 hours ago
    },
    {
      originalText: `${SEED_TAG} need 3bhk near Manish Nagar 80L under construction`,
      agentIdx: 0,
      params: { bhkType: '3BHK', budget: 80, budgetMax: null, location: 'manish_nagar', locationRaw: 'near Manish Nagar', locationCanonical: 'manish_nagar', city: 'Nagpur', propertyType: null, possessionNeeded: '1year', loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.82, paramCount: 4,
      status: 'auto_detected', matchProjectIdx: 0, matchScore: 55,
      createdAgo: 3 * 3600000
    },
    {
      originalText: `${SEED_TAG} ghar chahiye 2bhk 45 lakh Manewada road loan chahiye jaldi`,
      agentIdx: 1,
      params: { bhkType: '2BHK', budget: 45, budgetMax: null, location: 'manewada', locationRaw: 'Manewada road', locationCanonical: 'manewada', city: 'Nagpur', propertyType: 'flat', possessionNeeded: null, loanRequired: true, urgency: 'urgent' },
      intent: 'requirement', confidence: 0.85, paramCount: 5,
      status: 'auto_detected', matchProjectIdx: null, matchScore: 0,
      createdAgo: 4 * 3600000
    },

    // ══════════ OKAY CASE: Lower confidence, implicit detection ══════════
    {
      originalText: `${SEED_TAG} 2bhk 50L Koradi road`,
      agentIdx: 2 % agents.length,
      params: { bhkType: '2BHK', budget: 50, budgetMax: null, location: 'koradi', locationRaw: 'Koradi road', locationCanonical: 'koradi', city: null, propertyType: null, possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'implicit_requirement', confidence: 0.58, paramCount: 3,
      status: 'auto_detected', matchProjectIdx: null, matchScore: 0,
      createdAgo: 6 * 3600000
    },
    {
      originalText: `${SEED_TAG} flat pahije 3bhk Dharampeth 90 lakh ready`,
      agentIdx: 0,
      params: { bhkType: '3BHK', budget: 90, budgetMax: null, location: 'dharampeth', locationRaw: 'Dharampeth', locationCanonical: 'dharampeth', city: 'Nagpur', propertyType: 'flat', possessionNeeded: 'immediate', loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.88, paramCount: 5,
      status: 'confirmed', matchProjectIdx: 4 % projects.length, matchScore: 72,
      createdAgo: 12 * 3600000
    },

    // ══════════ CONVERTED LEAD (success story) ══════════
    {
      originalText: `${SEED_TAG} looking for 2bhk flat Manish Nagar 55L ready to move`,
      agentIdx: 1,
      params: { bhkType: '2BHK', budget: 55, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', locationCanonical: 'manish_nagar', city: 'Nagpur', propertyType: 'flat', possessionNeeded: 'immediate', loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.93, paramCount: 5,
      status: 'converted', matchProjectIdx: 0, matchScore: 90,
      createdAgo: 2 * 24 * 3600000 // 2 days ago
    },

    // ══════════ REJECTED LEAD (false positive example) ══════════
    {
      originalText: `${SEED_TAG} sold my 2bhk in Manish Nagar for 58L last week`,
      agentIdx: 2 % agents.length,
      params: { bhkType: '2BHK', budget: 58, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', locationCanonical: 'manish_nagar', city: 'Nagpur', propertyType: null, possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'implicit_requirement', confidence: 0.45, paramCount: 3,
      status: 'rejected', matchProjectIdx: 0, matchScore: 88,
      createdAgo: 3 * 24 * 3600000
    },

    // ══════════ MULTI-LOCATION / FOLLOW-UP ══════════
    {
      originalText: `${SEED_TAG} need 2bhk near Manish Nagar or Wardha Road area 60L budget`,
      agentIdx: 0,
      params: { bhkType: '2BHK', budget: 60, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar or Wardha Road', locationCanonical: 'manish_nagar', city: 'Nagpur', propertyType: null, possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.87, paramCount: 4,
      status: 'auto_detected', matchProjectIdx: 0, matchScore: 75,
      createdAgo: 30 * 60000
    },
    {
      originalText: `${SEED_TAG} same area but 3bhk and budget 80L`,
      agentIdx: 0,
      params: { bhkType: '3BHK', budget: 80, budgetMax: null, location: 'manish_nagar', locationRaw: 'Manish Nagar', locationCanonical: 'manish_nagar', city: 'Nagpur', propertyType: null, possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'follow_up_requirement', confidence: 0.80, paramCount: 3,
      status: 'auto_detected', matchProjectIdx: 0, matchScore: 52,
      createdAgo: 25 * 60000
    },

    // ══════════ WORST CASE: Very low confidence ══════════
    {
      originalText: `${SEED_TAG} 2bhk 40L somewhere`,
      agentIdx: 1,
      params: { bhkType: '2BHK', budget: 40, budgetMax: null, location: null, locationRaw: null, locationCanonical: null, city: null, propertyType: null, possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'implicit_requirement', confidence: 0.35, paramCount: 2,
      status: 'auto_detected', matchProjectIdx: null, matchScore: 0,
      createdAgo: 8 * 3600000
    },
    {
      originalText: `${SEED_TAG} plot chahiye 30L Hingna MIDC ke paas`,
      agentIdx: 2 % agents.length,
      params: { bhkType: null, budget: 30, budgetMax: null, location: 'hingna', locationRaw: 'Hingna MIDC', locationCanonical: 'hingna', city: 'Nagpur', propertyType: 'plot', possessionNeeded: null, loanRequired: false, urgency: 'normal' },
      intent: 'requirement', confidence: 0.72, paramCount: 3,
      status: 'auto_detected', matchProjectIdx: null, matchScore: 0,
      createdAgo: 5 * 3600000
    },

    // ══════════ VERY URGENT HIGH VALUE ══════════
    {
      originalText: `${SEED_TAG} very urgent need 4bhk villa Civil Lines 2cr+ ready possession loan available must`,
      agentIdx: 0,
      params: { bhkType: '4BHK', budget: 200, budgetMax: null, location: 'civil_lines', locationRaw: 'Civil Lines', locationCanonical: 'civil_lines', city: 'Nagpur', propertyType: 'villa', possessionNeeded: 'immediate', loanRequired: true, urgency: 'very_urgent' },
      intent: 'requirement', confidence: 0.95, paramCount: 7,
      status: 'auto_detected', matchProjectIdx: 5 % projects.length, matchScore: 68,
      createdAgo: 10 * 60000
    },
  ];

  for (const s of scenarios) {
    const agent = pickAgent(s.agentIdx);
    const matchProject = s.matchProjectIdx !== null ? pickProject(s.matchProjectIdx) : null;

    const matches = matchProject ? [{
      project: matchProject._id,
      score: s.matchScore,
      confidence: s.matchScore / 100,
      matchedOn: buildMatchedOn(s.params, matchProject)
    }] : [];

    const lead = await ExtractedLead.create({
      source: 'group_chat',
      sourceRoom: groupRoom._id,
      sourceRoomModel: 'GroupRoom',
      originalText: s.originalText,
      extractedBy: agent._id,
      extractedByRole: agent.role,
      params: s.params,
      intent: s.intent,
      extractionConfidence: s.confidence,
      paramCount: s.paramCount,
      matches,
      matchCount: matches.length,
      bestMatchScore: s.matchScore,
      status: s.status,
      adminNotified: true,
      adminNotifiedAt: new Date(now - s.createdAgo),
      createdAt: new Date(now - s.createdAgo),
      updatedAt: new Date(now - s.createdAgo),
    });

    const statusIcon = s.status === 'converted' ? '★' : s.status === 'confirmed' ? '✓' : s.status === 'rejected' ? '✗' : '●';
    console.log(`  ${statusIcon} [${s.status.padEnd(13)}] conf:${(s.confidence*100).toFixed(0).padStart(3)}% | ${(s.params.bhkType||'-').padEnd(4)} ${(s.params.budget?s.params.budget+'L':'-').padEnd(5)} ${(s.params.locationRaw||'-').padEnd(16)} | matches:${s.matchScore||0}% | ${agent.name}`);
    createdLeads.push(lead);
  }

  console.log(`\n  Total leads created: ${createdLeads.length}`);
  return createdLeads;
}

function buildMatchedOn(params, project) {
  const on = [];
  if (params.budget && project.pricing?.startingPrice) on.push('budget');
  if (params.location && project.location) on.push('location');
  if (params.bhkType && project.configuration?.bhkOptions?.length) on.push('bhk');
  if (params.loanRequired && project.pricing?.bankLoanAvailable) on.push('loan');
  if (params.possessionNeeded) on.push('possession');
  return on.length > 0 ? on : ['budget', 'location'];
}

async function createAdminNotifications(admin, leads, agents) {
  console.log('\n  Creating admin notifications...');

  const recentLeads = leads.filter(l => l.status === 'auto_detected').slice(0, 5);

  for (const lead of recentLeads) {
    const agent = agents.find(a => a._id.toString() === lead.extractedBy.toString()) || agents[0];
    const params = lead.params;
    const paramSummary = [
      params.bhkType, params.propertyType,
      params.budget ? `${params.budget}L` : null,
      params.locationRaw
    ].filter(Boolean).join(', ');

    await Notification.create({
      recipient: admin._id,
      type: 'lead_match',
      title: `${SEED_TAG} Lead from ${agent.name} (${agent.role})`,
      message: `${paramSummary} — ${lead.matchCount > 0 ? `${lead.matchCount} match (${lead.bestMatchScore}%)` : 'No matches yet'}`,
      reference: { model: 'ExtractedLead', id: lead._id },
      read: false,
      createdAt: lead.createdAt
    });
  }

  console.log(`  ${recentLeads.length} notifications created for admin`);
}

async function cleanup() {
  console.log('Cleaning up seeded test data...');
  const r1 = await ExtractedLead.deleteMany({ originalText: { $regex: /^\[SEED-TEST\]/ } });
  const r2 = await Notification.deleteMany({ title: { $regex: /^\[SEED-TEST\]/ } });
  console.log(`  Deleted ${r1.deletedCount} leads, ${r2.deletedCount} notifications`);
  console.log('Done!');
}

main();
