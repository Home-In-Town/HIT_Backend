/**
 * Seed Script for Lead Matching Testing
 * 
 * Creates test data to verify the NLP lead matching system on localhost:
 *   - 1 Admin user
 *   - 1 Captain user
 *   - 2 Agent users (one under captain)
 *   - 1 Builder user with 3 published projects in different locations
 *   - 1 Group room with all users as members
 * 
 * Usage:
 *   node scripts/seed-lead-matching.js
 * 
 * After running, use the printed JWT tokens to test via Postman or the socket test scripts.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connectDB } = require('../config/db');

const User = require('../models/User');
const Project = require('../models/Project');
const GroupRoom = require('../models/GroupRoom');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

// ─── Test Data ────────────────────────────────────────────────────────────────

const TEST_USERS = [
  {
    name: 'Admin TestUser',
    phone: '9900000001',
    role: 'admin',
    mpin: '1234',
    companyName: 'HIT Admin Corp',
    isActive: true,
    isVerified: true
  },
  {
    name: 'Captain Sharma',
    phone: '9900000002',
    role: 'captain',
    mpin: '1234',
    companyName: 'Sharma Properties',
    businessCity: 'Nagpur',
    isActive: true,
    isVerified: true
  },
  {
    name: 'Agent Rahul',
    phone: '9900000003',
    role: 'agent',
    mpin: '1234',
    companyName: 'Rahul Realty',
    isActive: true,
    isVerified: true
    // employerId will be set to captain
  },
  {
    name: 'Agent Priya',
    phone: '9900000004',
    role: 'agent',
    mpin: '1234',
    companyName: 'Priya Estates',
    isActive: true,
    isVerified: true
  },
  {
    name: 'Builder Mehta',
    phone: '9900000005',
    role: 'builder',
    mpin: '1234',
    companyName: 'Mehta Constructions',
    isActive: true,
    isVerified: true,
    verificationStatus: { builder: 'verified', agent: 'unverified' }
  }
];

const TEST_PROJECTS = [
  {
    projectName: 'Green Heights Manish Nagar',
    projectType: 'flat',
    category: 'Residential',
    city: 'Nagpur',
    location: 'Manish Nagar',
    latitude: 21.1100,
    longitude: 79.0400,
    reraApproved: true,
    reraNumber: 'RERA-NGP-001',
    projectStatus: 'under-construction',
    pricing: {
      startingPrice: 5500000, // 55 lakh
      pricePerSqFt: 5500,
      bankLoanAvailable: true
    },
    configuration: {
      bhkOptions: ['1BHK', '2BHK', '3BHK'],
      carpetAreaRange: '650-1200 sqft',
      gatedCommunity: true
    },
    amenities: ['Swimming Pool', 'Gym', 'Garden', 'Parking'],
    status: 'published',
    slug: 'green-heights-manish-nagar'
  },
  {
    projectName: 'Skyline Residency Wardha Road',
    projectType: 'flat',
    category: 'Residential',
    city: 'Nagpur',
    location: 'Wardha Road',
    latitude: 21.1100,
    longitude: 79.1200,
    reraApproved: true,
    reraNumber: 'RERA-NGP-002',
    projectStatus: 'ready-to-move',
    pricing: {
      startingPrice: 6200000, // 62 lakh
      pricePerSqFt: 6000,
      bankLoanAvailable: true
    },
    configuration: {
      bhkOptions: ['2BHK', '3BHK'],
      carpetAreaRange: '800-1400 sqft',
      gatedCommunity: true
    },
    amenities: ['Clubhouse', 'Gym', 'Garden', 'Security'],
    status: 'published',
    slug: 'skyline-residency-wardha-road'
  },
  {
    projectName: 'Pratap Villa Homes',
    projectType: 'villa',
    category: 'Residential',
    city: 'Nagpur',
    location: 'Pratap Nagar',
    latitude: 21.1350,
    longitude: 79.0550,
    reraApproved: false,
    projectStatus: 'pre-launch',
    pricing: {
      startingPrice: 12000000, // 1.2 crore
      pricePerSqFt: 7500,
      bankLoanAvailable: true
    },
    configuration: {
      bhkOptions: ['3BHK', '4BHK'],
      carpetAreaRange: '1500-2500 sqft',
      gatedCommunity: true
    },
    amenities: ['Private Garden', 'Parking', 'Clubhouse'],
    status: 'published',
    slug: 'pratap-villa-homes'
  }
];

// ─── Main Seed Function ───────────────────────────────────────────────────────

async function seed() {
  try {
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Clean up any existing test data (by phone numbers)
    const testPhones = TEST_USERS.map(u => u.phone);
    await User.deleteMany({ phone: { $in: testPhones } });
    await Project.deleteMany({ slug: { $in: TEST_PROJECTS.map(p => p.slug) } });
    await GroupRoom.deleteMany({ name: 'Nagpur Lead Matching Test Room' });
    console.log('🧹 Cleaned up previous test data\n');

    // Create users
    const hashedMpin = await bcrypt.hash('1234', 10);
    const createdUsers = [];

    for (const userData of TEST_USERS) {
      const user = await User.create({
        ...userData,
        mpin: hashedMpin
      });
      createdUsers.push(user);
    }

    const [admin, captain, agentRahul, agentPriya, builder] = createdUsers;

    // Set Rahul's employer to captain
    await User.findByIdAndUpdate(agentRahul._id, {
      employerId: captain._id,
      isEmployerConfirmed: true
    });

    console.log('👥 Users created:');
    for (const user of createdUsers) {
      const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
      console.log(`   ${user.role.padEnd(8)} | ${user.name.padEnd(20)} | Phone: ${user.phone}`);
      console.log(`            Token: ${token}\n`);
    }

    // Create projects (owned by builder)
    const createdProjects = [];
    for (const projData of TEST_PROJECTS) {
      const project = await Project.create({
        ...projData,
        owner: builder._id
      });
      createdProjects.push(project);
    }

    console.log('🏗️  Projects created:');
    for (const proj of createdProjects) {
      console.log(`   ${proj.projectName} | ${proj.location} | ₹${(proj.pricing.startingPrice / 100000).toFixed(0)}L | ${proj.configuration.bhkOptions.join(', ')}`);
    }
    console.log('');

    // Create group room with all members
    const groupRoom = await GroupRoom.create({
      name: 'Nagpur Lead Matching Test Room',
      roomType: 'area',
      area: { city: 'Nagpur', location: 'All Areas' },
      createdBy: admin._id,
      description: 'Test room for NLP lead matching',
      members: createdUsers.map((u, idx) => ({
        user: u._id,
        role: idx === 0 ? 'admin' : 'member'
      })),
      lastActivity: new Date()
    });

    console.log(`💬 Group Room created: "${groupRoom.name}" (ID: ${groupRoom._id})\n`);

    // Print test instructions
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  TEST INSTRUCTIONS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('1. Start the server: npm run dev');
    console.log('');
    console.log('2. Test NLP extraction (Postman/cURL):');
    console.log('   POST http://localhost:5001/api/lead-matching/extract');
    console.log('   Header: Authorization: Bearer <agent_token>');
    console.log('   Body: { "text": "I need 2bhk flat near Manish Nagar 60 lakh budget" }');
    console.log('');
    console.log('3. Test full matching:');
    console.log('   POST http://localhost:5001/api/lead-matching/test-match');
    console.log('   Header: Authorization: Bearer <agent_token>');
    console.log('   Body: { "text": "looking for 2bhk flat near Manish Nagar 60L budget" }');
    console.log('');
    console.log('4. Send message in group chat (triggers real lead capture):');
    console.log(`   POST http://localhost:5001/api/group-chat/rooms/${groupRoom._id}/messages`);
    console.log('   Header: Authorization: Bearer <agent_token>');
    console.log('   Body: { "messageType": "text", "content": "I need 2bhk flat near Manish Nagar 60 lakh" }');
    console.log('');
    console.log('5. Check admin notifications:');
    console.log('   GET http://localhost:5001/api/notifications');
    console.log('   Header: Authorization: Bearer <admin_token>');
    console.log('');
    console.log('6. View extracted leads:');
    console.log('   GET http://localhost:5001/api/lead-matching/leads');
    console.log('   Header: Authorization: Bearer <admin_token>');
    console.log('');
    console.log('7. View stats:');
    console.log('   GET http://localhost:5001/api/lead-matching/stats');
    console.log('   Header: Authorization: Bearer <admin_token>');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('TEST MESSAGES TO TRY:');
    console.log('  ✓ "I need 2bhk flat near Manish Nagar 60 lakh budget"');
    console.log('  ✓ "looking for 2bhk near manish nagr road 55L"  (typo + noise)');
    console.log('  ✓ "client wants 3bhk villa in Pratap Nagar 1.2cr ready possession"');
    console.log('  ✓ "anyone has 2bhk flat wardha road area 60-65 lakh loan required"');
    console.log('  ✗ "good morning everyone"  (should NOT trigger)');
    console.log('  ✗ "deal done, congrats!"   (should NOT trigger)');
    console.log('');

    await mongoose.disconnect();
    console.log('✅ Seed complete. Database disconnected.');
    process.exit(0);

  } catch (err) {
    console.error('❌ Seed error:', err);
    process.exit(1);
  }
}

seed();
