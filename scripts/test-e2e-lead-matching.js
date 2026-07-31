/**
 * End-to-End Lead Matching Test
 * 
 * Tests the ENTIRE lead matching pipeline on localhost:
 *   1. Seeds test data (users, projects, group room)
 *   2. Tests NLP extraction
 *   3. Tests forward matching (message → projects)
 *   4. Tests reverse matching (new project → existing leads)
 *   5. Tests deduplication
 *   6. Tests conversation context / follow-ups
 *   7. Reports results
 * 
 * Prerequisites:
 *   - MongoDB running (your .env connection)
 *   - Server NOT running (this script uses DB directly)
 * 
 * Usage:
 *   node scripts/test-e2e-lead-matching.js
 */

require('dotenv').config();

// Force Google DNS (fixes SRV lookup issues on local routers)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const Project = require('../models/Project');
const GroupRoom = require('../models/GroupRoom');
const GroupMessage = require('../models/GroupMessage');
const ExtractedLead = require('../models/ExtractedLead');
const Notification = require('../models/Notification');

const leadCaptureService = require('../services/LeadCaptureService');
const reverseMatchService = require('../services/ReverseMatchService');
const nlpExtractor = require('../services/NLPExtractor');
const conversationContext = require('../services/ConversationContext');

const { connectDB } = require('../config/db');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

// Test state
let totalTests = 0, passed = 0, failed = 0;
const results = [];
let admin, captain, agentRahul, agentPriya, builder;
let project1, project2, project3, groupRoom, tokens = {};

function assert(condition, testName, detail) {
  totalTests++;
  if (condition) { passed++; results.push({ s: '✓', t: testName }); }
  else { failed++; results.push({ s: '✗', t: testName, d: detail }); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function seedData() {
  console.log('🌱 Seeding test data...');
  const phones = ['9911000001','9911000002','9911000003','9911000004','9911000005'];
  await User.deleteMany({ phone: { $in: phones } });
  await Project.deleteMany({ slug: /^e2e-/ });
  await GroupRoom.deleteMany({ name: 'E2E Test Room' });
  await ExtractedLead.deleteMany({ originalText: /^e2e:/i });
  await Notification.deleteMany({ title: /E2E/ });

  const mpin = await bcrypt.hash('1234', 10);
  admin = await User.create({ name:'E2E Admin', phone:'9911000001', role:'admin', mpin, isActive:true, isVerified:true });
  captain = await User.create({ name:'E2E Captain', phone:'9911000002', role:'captain', mpin, isActive:true, isVerified:true });
  agentRahul = await User.create({ name:'E2E Agent Rahul', phone:'9911000003', role:'agent', mpin, isActive:true, isVerified:true, employerId:captain._id, isEmployerConfirmed:true });
  agentPriya = await User.create({ name:'E2E Agent Priya', phone:'9911000004', role:'agent', mpin, isActive:true, isVerified:true });
  builder = await User.create({ name:'E2E Builder', phone:'9911000005', role:'builder', mpin, isActive:true, isVerified:true, verificationStatus:{builder:'verified'} });

  tokens = { admin: jwt.sign({id:admin._id},JWT_SECRET), agentRahul: jwt.sign({id:agentRahul._id},JWT_SECRET), agentPriya: jwt.sign({id:agentPriya._id},JWT_SECRET), builder: jwt.sign({id:builder._id},JWT_SECRET) };

  project1 = await Project.create({ projectName:'E2E Green Heights', projectType:'flat', city:'Nagpur', location:'Manish Nagar', latitude:21.11, longitude:79.04, reraApproved:true, projectStatus:'under-construction', pricing:{startingPrice:5500000, bankLoanAvailable:true}, configuration:{bhkOptions:['1BHK','2BHK','3BHK']}, owner:builder._id, status:'published', slug:'e2e-green-heights', cta:{whatsappNumber:'9911000005'} });
  project2 = await Project.create({ projectName:'E2E Skyline Wardha', projectType:'flat', city:'Nagpur', location:'Wardha Road', latitude:21.11, longitude:79.12, reraApproved:true, projectStatus:'ready-to-move', pricing:{startingPrice:6200000, bankLoanAvailable:true}, configuration:{bhkOptions:['2BHK','3BHK']}, owner:builder._id, status:'published', slug:'e2e-skyline-wardha', cta:{whatsappNumber:'9911000005'} });
  project3 = await Project.create({ projectName:'E2E Pratap Villa', projectType:'villa', city:'Nagpur', location:'Pratap Nagar', latitude:21.135, longitude:79.055, reraApproved:false, projectStatus:'pre-launch', pricing:{startingPrice:12000000, bankLoanAvailable:true}, configuration:{bhkOptions:['3BHK','4BHK']}, owner:builder._id, status:'published', slug:'e2e-pratap-villa', cta:{whatsappNumber:'9911000005'} });

  groupRoom = await GroupRoom.create({ name:'E2E Test Room', roomType:'area', area:{city:'Nagpur',location:'All'}, createdBy:admin._id, members:[admin,captain,agentRahul,agentPriya,builder].map((u,i)=>({user:u._id,role:i===0?'admin':'member'})), lastActivity:new Date() });

  console.log('   ✅ 5 users, 3 projects, 1 group room created\n');
}

// ═══ TEST 1: NLP Extraction ═══
async function test1_NLP() {
  console.log('═══ TEST 1: NLP Extraction ═══');
  const r1 = nlpExtractor.extract('I need 2bhk flat near Manish Nagar 60 lakh budget');
  assert(r1 !== null, '1.1 English requirement detected');
  assert(r1?.params?.bhkType === '2BHK', '1.2 BHK = 2BHK');
  assert(r1?.params?.budget === 60, '1.3 Budget = 60L');
  assert(r1?.params?.location === 'manish_nagar', '1.4 Location = manish_nagar');
  assert(r1?.params?.propertyType === 'flat', '1.5 PropertyType = flat');

  const r2 = nlpExtractor.extract('2bhk flat chahiye Manish Nagar mein 55L');
  assert(r2 !== null, '1.6 Hindi chahiye detected');
  assert(r2?.params?.budget === 55, '1.7 Hindi budget = 55');

  const r3 = nlpExtractor.extract('2bhk flat pahije Wardha Road 60 lakh');
  assert(r3 !== null, '1.8 Marathi pahije detected');

  assert(nlpExtractor.extract('good morning everyone') === null, '1.9 Greeting rejected');
  assert(nlpExtractor.extract('deal done congrats') === null, '1.10 Status update rejected');
  assert(nlpExtractor.extract('ok noted') === null, '1.11 Short ack rejected');

  const r6 = nlpExtractor.extract('need 2bhk 50 to 60 lakh Manish Nagar');
  assert(r6?.params?.budget === 50 && r6?.params?.budgetMax === 60, '1.12 Budget range 50-60L');

  const r7 = nlpExtractor.extract('need 2bhk around 55L Manish Nagar negotiable');
  assert(r7?.params?.budgetFlexible === true, '1.13 Flexible budget detected');

  const multi = nlpExtractor.extractAll('need 2bhk manish nagar 60L and also 3bhk besa 80L');
  assert(multi.length === 2, '1.14 Multi-req: 2 detected');
  console.log('');
}

// ═══ TEST 2: Forward Matching ═══
async function test2_ForwardMatch() {
  console.log('═══ TEST 2: Forward Matching (Message → Projects) ═══');
  const msg = await GroupMessage.create({ room:groupRoom._id, sender:agentRahul._id, messageType:'text', content:'e2e: I need 2bhk flat near Manish Nagar 60 lakh budget loan required' });

  const result = await leadCaptureService.processMessage({
    text: 'e2e: I need 2bhk flat near Manish Nagar 60 lakh budget loan required',
    sender: { _id:agentRahul._id, name:'E2E Agent Rahul', role:'agent' },
    source: 'group_chat', messageId: msg._id, roomId: groupRoom._id, io: null
  });

  assert(result.extracted === true, '2.1 Extraction succeeded');
  assert(result.lead !== null, '2.2 Lead persisted');
  assert(result.matches.length > 0, '2.3 Matches found: ' + result.matches.length);

  const dbLead = await ExtractedLead.findById(result.lead._id);
  assert(dbLead !== null, '2.4 Lead exists in DB');
  assert(dbLead.params.bhkType === '2BHK', '2.5 Lead params: 2BHK');
  assert(dbLead.params.loanRequired === true, '2.6 Lead params: loan=true');
  assert(dbLead.matchCount > 0, '2.7 matchCount > 0');
  assert(dbLead.status === 'auto_detected', '2.8 Status = auto_detected');

  const notif = await Notification.findOne({ recipient:admin._id, type:'lead_match', createdAt:{$gte:new Date(Date.now()-10000)} });
  assert(notif !== null, '2.9 Admin notification created');

  const greenMatch = result.matches.find(m => m.project?.projectName?.includes('Green Heights'));
  assert(greenMatch != null, '2.10 Green Heights in matches');
  assert(greenMatch?.score >= 60, '2.11 Green Heights score >= 60: ' + greenMatch?.score);
  console.log('');
}

// ═══ TEST 3: Reverse Matching ═══
async function test3_ReverseMatch() {
  console.log('═══ TEST 3: Reverse Matching (New Project → Existing Leads) ═══');

  const newProj = await Project.create({ projectName:'E2E Manish Residency NEW', projectType:'flat', city:'Nagpur', location:'Manish Nagar', latitude:21.112, longitude:79.041, reraApproved:true, projectStatus:'ready-to-move', pricing:{startingPrice:5800000, bankLoanAvailable:true}, configuration:{bhkOptions:['2BHK','3BHK']}, owner:builder._id, status:'published', slug:'e2e-manish-new-'+Date.now(), cta:{whatsappNumber:'9911000005'} });

  const fullProj = await Project.findById(newProj._id).populate('owner','name companyName role verificationStatus').lean();
  await reverseMatchService.onProjectPublished(fullProj, null);
  await sleep(300);

  const agentNotif = await Notification.findOne({ recipient:agentRahul._id, type:'lead_match', 'reference.id':newProj._id });
  assert(agentNotif !== null, '3.1 Agent notified of new matching project');

  const adminNotif = await Notification.findOne({ recipient:admin._id, type:'lead_match', 'reference.id':newProj._id });
  assert(adminNotif !== null, '3.2 Admin notified of reverse match');

  const updatedLead = await ExtractedLead.findOne({ extractedBy:agentRahul._id, 'matches.project':newProj._id });
  assert(updatedLead !== null, '3.3 ExtractedLead updated with new project');

  await Project.deleteOne({ _id: newProj._id });
  console.log('');
}

// ═══ TEST 4: Deduplication ═══
async function test4_Dedup() {
  console.log('═══ TEST 4: Deduplication ═══');
  const text = 'e2e: need 3bhk flat near Wardha Road 70L dedup test';
  const sender = { _id:agentPriya._id, name:'E2E Agent Priya', role:'agent' };

  const msg1 = await GroupMessage.create({ room:groupRoom._id, sender:agentPriya._id, messageType:'text', content:text });
  const r1 = await leadCaptureService.processMessage({ text, sender, source:'group_chat', messageId:msg1._id, roomId:groupRoom._id, io:null });
  assert(r1.extracted === true, '4.1 First message extracted');

  const msg2 = await GroupMessage.create({ room:groupRoom._id, sender:agentPriya._id, messageType:'text', content:text });
  const r2 = await leadCaptureService.processMessage({ text, sender, source:'group_chat', messageId:msg2._id, roomId:groupRoom._id, io:null });
  assert(r2.extracted === false, '4.2 Duplicate blocked');

  const text3 = 'e2e: looking for 2bhk besa 45L ready possession';
  const msg3 = await GroupMessage.create({ room:groupRoom._id, sender:agentPriya._id, messageType:'text', content:text3 });
  const r3 = await leadCaptureService.processMessage({ text:text3, sender, source:'group_chat', messageId:msg3._id, roomId:groupRoom._id, io:null });
  assert(r3.extracted === true, '4.3 Different message extracts');
  console.log('');
}

// ═══ TEST 5: Conversation Context / Follow-Up ═══
async function test5_FollowUp() {
  console.log('═══ TEST 5: Conversation Context & Follow-Up ═══');

  // Store context manually (simulating a previous extraction)
  conversationContext.store(agentRahul._id.toString(), groupRoom._id.toString(), { bhkType:'2BHK', budget:60, location:'manish_nagar', locationRaw:'Manish Nagar', propertyType:'flat' }, 'previous message');

  const prev = conversationContext.getLatest(agentRahul._id.toString(), groupRoom._id.toString());
  assert(prev !== null, '5.1 Context stored and retrievable');
  assert(prev?.bhkType === '2BHK', '5.2 Context has correct BHK');

  // Follow-up: "same area but 3bhk"
  const followUp = nlpExtractor.extract('same area but 3bhk', { previousParams: prev });
  assert(followUp !== null, '5.3 Follow-up detected');
  assert(followUp?.intent === 'follow_up_requirement', '5.4 Intent = follow_up_requirement');
  assert(followUp?.params?.bhkType === '3BHK', '5.5 BHK changed to 3BHK');
  assert(followUp?.params?.location === 'manish_nagar', '5.6 Location preserved from context');

  // Follow-up: "increase budget to 75L"
  const budgetUp = nlpExtractor.extract('increase budget to 75L', { previousParams: prev });
  assert(budgetUp?.params?.budget === 75, '5.7 Budget increased to 75L');
  assert(budgetUp?.params?.bhkType === '2BHK', '5.8 BHK preserved');
  console.log('');
}

// ═══ TEST 6: Location Edge Cases ═══
async function test6_LocationEdges() {
  console.log('═══ TEST 6: Location Fuzzy Matching ═══');
  const ln = require('../services/LocationNormalizer');

  const n1 = ln.normalize('near Manish Nagar road');
  assert(n1.canonical === 'manish_nagar', '6.1 "near Manish Nagar road" → manish_nagar');

  const n2 = ln.normalize('manish nagr');
  assert(n2.canonical === 'manish_nagar', '6.2 Typo "manish nagr" → manish_nagar');
  assert(n2.confidence >= 0.8, '6.3 Typo confidence >= 0.8: ' + n2.confidence?.toFixed(2));

  const n3 = ln.normalize('behind Manish Nagar extension');
  assert(n3.canonical === 'manish_nagar', '6.4 "behind X extension" → manish_nagar');

  const same = ln.isSameArea('near manish nagar', 'Manish Nagar');
  assert(same.matches === true, '6.5 isSameArea: "near X" == "X"');

  const diff = ln.isSameArea('manish nagar', 'Wardha Road');
  assert(diff.matches === false, '6.6 isSameArea: different areas = false');

  const geo = ln.isSameArea('manish nagar', 'Some Place', { lat: 21.111, lng: 79.041 });
  assert(geo.matches === true, '6.7 Geo proximity match (<2km)');
  console.log('');
}

// ═══ TEST 7: Stats Endpoint Data ═══
async function test7_Stats() {
  console.log('═══ TEST 7: Lead Stats ═══');
  const total = await ExtractedLead.countDocuments({ originalText: /^e2e:/i });
  assert(total >= 3, '7.1 At least 3 leads in DB from tests: ' + total);

  const withMatches = await ExtractedLead.countDocuments({ originalText: /^e2e:/i, matchCount: { $gt: 0 } });
  assert(withMatches >= 1, '7.2 At least 1 lead has matches: ' + withMatches);

  const notifCount = await Notification.countDocuments({ recipient: admin._id, type: 'lead_match' });
  assert(notifCount >= 2, '7.3 Admin has >= 2 lead_match notifications: ' + notifCount);
  console.log('');
}

// ═══ CLEANUP + REPORT ═══
async function cleanup() {
  const phones = ['9911000001','9911000002','9911000003','9911000004','9911000005'];
  await User.deleteMany({ phone: { $in: phones } });
  await Project.deleteMany({ slug: /^e2e-/ });
  await GroupRoom.deleteMany({ name: 'E2E Test Room' });
  await GroupMessage.deleteMany({ room: groupRoom?._id });
  await ExtractedLead.deleteMany({ originalText: /^e2e:/i });
  await Notification.deleteMany({ title: /E2E/ });
}

function printReport() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║       END-TO-END LEAD MATCHING — TEST REPORT             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  for (const r of results) {
    if (r.s === '✓') console.log(`  ${r.s} ${r.t}`);
    else console.log(`  ${r.s} ${r.t}${r.d ? ' → ' + r.d : ''}`);
  }
  console.log('');
  console.log('─'.repeat(55));
  console.log(`  Total: ${totalTests} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  Accuracy: ${((passed/totalTests)*100).toFixed(1)}%`);
  console.log('─'.repeat(55));
  if (failed === 0) console.log('  🎉 ALL TESTS PASSED');
  else console.log(`  ⚠️  ${failed} test(s) failed — review above`);
  console.log('');
}

// ═══ MAIN ═══
async function main() {
  try {
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    await seedData();
    await test1_NLP();
    await test2_ForwardMatch();
    await test3_ReverseMatch();
    await test4_Dedup();
    await test5_FollowUp();
    await test6_LocationEdges();
    await test7_Stats();

    printReport();
    await cleanup();
    console.log('🧹 Test data cleaned up');
  } catch (err) {
    console.error('❌ Fatal error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
