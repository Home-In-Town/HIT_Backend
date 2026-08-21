/**
 * LIVE DEMO TEST — Watch in Browser!
 * 
 * This script uses the REAL HTTP API (not direct DB access).
 * Run your server first, then run this script.
 * Open the frontend in browser and watch groups/messages appear in real-time.
 * 
 * Prerequisites:
 *   1. Backend running: node server.js (default port 5001)
 *   2. Frontend running: npm run dev (default port 3000)
 *   3. Open browser: http://localhost:3000/dashboard/group-chat
 *   4. Login as admin (phone: 9933000001, mpin: 1234) to see everything
 * 
 * Usage: node scripts/live-demo-test.js
 * 
 * What you'll see in the UI:
 *   - "HIT Community" universal group appears
 *   - Test users join the group
 *   - Requirement messages posted (with NLP extraction)
 *   - Inventory cards posted
 *   - Sub-groups auto-created when leads match projects
 *   - System messages with project details in sub-groups
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5001';
const JWT_SECRET = process.env.JWT_SECRET;
const DELAY = 2000; // 2 seconds between actions so you can watch

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(method, path, body, token) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    redirect: 'manual'
  };
  if (token) opts.headers['Cookie'] = `token=${token}`;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);
  
  // Extract token from set-cookie header (try multiple header formats)
  let extractedToken = null;
  const rawHeaders = res.headers.raw ? res.headers.raw() : null;
  const setCookieHeaders = rawHeaders?.['set-cookie'] || [];
  
  // Try standard get
  const setCookie = res.headers.get('set-cookie');
  const allCookies = setCookieHeaders.length > 0 ? setCookieHeaders.join('; ') : (setCookie || '');
  
  if (allCookies) {
    const match = allCookies.match(/token=([^;]+)/);
    if (match) extractedToken = match[1];
  }

  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) {
      return { error: data.error || data.message || res.statusText, status: res.status, _token: extractedToken };
    }
    if (extractedToken) data._token = extractedToken;
    return data;
  } catch {
    return { error: text, status: res.status, _token: extractedToken };
  }
}

function log(emoji, msg) {
  console.log(`  ${emoji}  ${msg}`);
}

function stepHeader(num, title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  STEP ${num}: ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// ═══════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════

const TEST_USERS = [
  { name: 'Demo Captain', phone: '9933000001', role: 'captain', mpin: '1234' },
  { name: 'Rahul Agent', phone: '9933000002', role: 'captain', mpin: '1234' },
  { name: 'Priya Agent', phone: '9933000003', role: 'captain', mpin: '1234' },
  { name: 'Sai Builders', phone: '9933000004', role: 'captain', mpin: '1234', companyName: 'Sai Constructions' },
  { name: 'Raj Developers', phone: '9933000005', role: 'captain', mpin: '1234', companyName: 'Raj Developers' },
];

let tokens = {};
let universalGroupId = null;

// ═══════════════════════════════════════════════════════════
// STEP 1: Register/Login Users
// ═══════════════════════════════════════════════════════════
async function step1_RegisterUsers() {
  stepHeader(1, 'Registering Demo Users');
  log('📝', 'Registering 5 test users via API...');

  for (const user of TEST_USERS) {
    await sleep(500);

    // Register (will auto-verify due to OTP bypass)
    const regResult = await api('POST', '/api/auth/register', {
      name: user.name,
      phone: `+91${user.phone}`,
      mpin: user.mpin,
      role: user.role,
      companyName: user.companyName || undefined
    });

    if (regResult._token) {
      tokens[user.phone] = regResult._token;
      log('✅', `${user.name} — registered & got token`);
      continue;
    }

    // If already exists, login
    if (regResult.error && regResult.error.includes('already exists')) {
      const loginResult = await api('POST', '/api/auth/login', {
        phone: `+91${user.phone}`, mpin: user.mpin
      });
      if (loginResult._token) {
        tokens[user.phone] = loginResult._token;
        log('✅', `${user.name} — logged in (already existed)`);
        continue;
      }
    }

    // Fallback: generate JWT directly (we have the secret)
    if (!tokens[user.phone] && JWT_SECRET) {
      // Login succeeded — user object returned — but cookie not captured by fetch
      const checkResult = await api('POST', '/api/auth/login', {
        phone: `+91${user.phone}`, mpin: user.mpin
      });

      if (checkResult._token) {
        tokens[user.phone] = checkResult._token;
        log('✅', `${user.name} — token from login cookie`);
      } else if (checkResult.user?.id) {
        // Generate token manually with the same secret the server uses
        const token = jwt.sign(
          { id: checkResult.user.id, name: checkResult.user.name || user.name, role: checkResult.user.role || user.role, phone: `+91${user.phone}` },
          JWT_SECRET,
          { expiresIn: '1d' }
        );
        tokens[user.phone] = token;
        log('✅', `${user.name} — token generated locally (JWT_SECRET)`);
      } else {
        log('❌', `${user.name} — cannot authenticate: ${checkResult.error || 'no user returned'}`);
      }
    }
  }

  log('🎯', `Got tokens for ${Object.keys(tokens).length}/${TEST_USERS.length} users`);
  
  // Debug: show token prefixes
  for (const [phone, token] of Object.entries(tokens)) {
    log('🔑', `${phone}: ${token ? token.substring(0, 20) + '...' : 'NULL'}`);
  }

  if (Object.keys(tokens).length === 0) {
    log('💥', 'No tokens acquired! Check if server is running and JWT_SECRET matches.');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 2: Verify Universal Group Exists
// ═══════════════════════════════════════════════════════════
async function step2_VerifyUniversalGroup() {
  stepHeader(2, 'Checking Universal Group');
  await sleep(DELAY);

  // Use first available token
  const token = tokens['9933000001'] || tokens['9933000004'] || tokens['9933000005'] || Object.values(tokens)[0];
  if (!token) {
    log('❌', 'No token available — cannot check rooms');
    return;
  }

  const result = await api('GET', '/api/group-chat/rooms', null, token);

  if (result.error) {
    log('❌', `Failed to fetch rooms: ${result.error}`);
    return;
  }

  const ug = result.myRooms?.find(r => r.isUniversal === true);
  if (ug) {
    universalGroupId = ug._id;
    log('✅', `"HIT Community" found! ${ug.members?.length || '?'} members`);
    log('👀', 'CHECK YOUR BROWSER — you should see "HIT Community" in Group Chat');
  } else {
    // Check all rooms
    const allRooms = [...(result.myRooms || []), ...(result.discoverRooms || [])];
    const ugDiscover = allRooms.find(r => r.name === 'HIT Community');
    if (ugDiscover) {
      universalGroupId = ugDiscover._id;
      log('⚠️', 'HIT Community found but user not yet a member. Joining...');
      await api('POST', `/api/group-chat/rooms/${ugDiscover._id}/join`, null, token);
      log('✅', 'Joined!');
    } else {
      log('❌', 'HIT Community NOT found. Make sure server ran ensureUniversalGroup() on startup.');
      log('💡', 'Restart your backend server and try again.');
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 3: Post Text Messages in Universal Group
// ═══════════════════════════════════════════════════════════
async function step3_PostMessages() {
  stepHeader(3, 'Posting Messages in HIT Community');

  if (!universalGroupId) {
    log('⏭️', 'Skipped — no universal group found');
    return;
  }

  const messages = [
    { phone: Object.keys(tokens)[0], text: 'Hello everyone! Welcome to HIT Community 🏠' },
    { phone: Object.keys(tokens)[1] || Object.keys(tokens)[0], text: 'Hi! I have clients looking for properties in Nagpur' },
    { phone: Object.keys(tokens)[0], text: 'We have some great projects in Manish Nagar area!' },
  ];

  for (const msg of messages) {
    await sleep(DELAY);
    const token = tokens[msg.phone];
    const userName = TEST_USERS.find(u => u.phone === msg.phone)?.name;

    const result = await api('POST', `/api/group-chat/rooms/${universalGroupId}/messages`, {
      messageType: 'text',
      content: msg.text
    }, token);

    if (result.message || result._id) {
      log('💬', `${userName}: "${msg.text}"`);
    } else {
      log('❌', `Failed: ${result.error}`);
    }
  }

  log('👀', 'CHECK BROWSER — messages should appear in HIT Community');
}

// ═══════════════════════════════════════════════════════════
// STEP 4: Post Requirements (Triggers Lead Matching!)
// ═══════════════════════════════════════════════════════════
async function step4_PostRequirements() {
  stepHeader(4, 'Posting Requirements — Watch Lead Matching!');

  if (!universalGroupId) {
    log('⏭️', 'Skipped — no universal group found');
    return;
  }

  const requirements = [
    {
      phone: Object.keys(tokens)[0],
      text: 'I need 2BHK flat near Manish Nagar, budget around 55 lakh, loan required',
      description: '2BHK, Manish Nagar, 55L, Loan'
    },
    {
      phone: Object.keys(tokens)[1] || Object.keys(tokens)[0],
      text: 'Client looking for 3BHK Wardha Road area 60-70 lakh range ready possession',
      description: '3BHK, Wardha Road, 60-70L'
    },
    {
      phone: Object.keys(tokens)[0],
      text: '2bhk flat chahiye Dharampeth mein 80 lakh budget hai',
      description: '2BHK, Dharampeth, 80L (Hindi)'
    },
  ];

  for (const req of requirements) {
    await sleep(DELAY * 1.5);
    const token = tokens[req.phone];
    const userName = TEST_USERS.find(u => u.phone === req.phone)?.name;

    log('🔍', `${userName} posting: "${req.description}"`);

    const result = await api('POST', `/api/group-chat/rooms/${universalGroupId}/messages`, {
      messageType: 'text',
      content: req.text
    }, token);

    if (result.message || result._id) {
      log('✅', `Message sent — NLP + Lead Matching running in background...`);
      log('👀', 'CHECK BROWSER — look for new sub-groups appearing!');
    } else {
      log('❌', `Failed: ${result.error}`);
    }
  }

  await sleep(3000); // Wait for background lead matching to complete
  log('⏳', 'Waiting 3s for lead matching to complete...');
}

// ═══════════════════════════════════════════════════════════
// STEP 5: Post Requirement Cards (Structured)
// ═══════════════════════════════════════════════════════════
async function step5_PostCards() {
  stepHeader(5, 'Posting Structured Requirement & Inventory Cards');

  if (!universalGroupId) {
    log('⏭️', 'Skipped — no universal group found');
    return;
  }

  // Requirement card
  await sleep(DELAY);
  const token2 = tokens[Object.keys(tokens)[1] || Object.keys(tokens)[0]];
  log('📋', 'Posting Requirement Card: 2BHK, Manish Nagar, 50L');

  const reqResult = await api('POST', `/api/group-chat/rooms/${universalGroupId}/messages`, {
    messageType: 'requirement_card',
    requirementCard: {
      bhkType: '2BHK',
      budget: 50,
      area: 'Manish Nagar',
      city: 'Nagpur',
      possessionNeeded: 'immediate',
      loanRequired: true,
      urgency: 'urgent',
      clientNotes: 'Client wants ground floor if possible'
    }
  }, token2);

  if (reqResult.message || reqResult._id) {
    log('✅', 'Requirement card posted — auto-matching triggered!');
  } else {
    log('❌', `Failed: ${reqResult.error}`);
  }

  // Inventory card
  await sleep(DELAY);
  const token4 = tokens[Object.keys(tokens)[0]];
  log('🏠', 'Posting Inventory Card: 2/3BHK, Manish Nagar, 45-65L');

  const invResult = await api('POST', `/api/group-chat/rooms/${universalGroupId}/messages`, {
    messageType: 'inventory_card',
    inventoryCard: {
      bhkOptions: ['2BHK', '3BHK'],
      priceRange: { min: 45, max: 65 },
      area: 'Manish Nagar',
      city: 'Nagpur',
      possessionStatus: 'ready',
      bankLoanAvailable: true,
      commissionPercent: 2,
      description: 'Prime location, RERA approved, bank loan available'
    }
  }, token4);

  if (invResult.message || invResult._id) {
    log('✅', 'Inventory card posted!');
  } else {
    log('❌', `Failed: ${invResult.error}`);
  }

  log('👀', 'CHECK BROWSER — you should see colored cards (orange/green) in the chat!');
}

// ═══════════════════════════════════════════════════════════
// STEP 6: Verify Sub-Groups Created
// ═══════════════════════════════════════════════════════════
async function step6_VerifySubGroups() {
  stepHeader(6, 'Verifying Sub-Groups Were Created');
  await sleep(DELAY);

  const token = tokens['9933000004'] || tokens['9933000005'] || Object.values(tokens)[0];
  if (!token) { log('❌', 'No token available'); return; }

  const result = await api('GET', '/api/group-chat/rooms', null, token);

  if (result.error) {
    log('❌', `Failed to fetch rooms: ${result.error}`);
    return;
  }

  const myRooms = result.myRooms || [];
  const universal = myRooms.filter(r => r.isUniversal);
  const subGroups = myRooms.filter(r => r.isAutoCreated);
  const manual = myRooms.filter(r => !r.isUniversal && !r.isAutoCreated);

  log('📊', `Total rooms for Rahul: ${myRooms.length}`);
  log('🌐', `Universal: ${universal.length} (HIT Community)`);
  log('🏗️', `Auto Sub-Groups: ${subGroups.length}`);
  log('📍', `Manual rooms: ${manual.length}`);

  if (subGroups.length > 0) {
    log('✅', 'Sub-groups CREATED! Lead matching is working!');
    subGroups.forEach(sg => {
      log('  🔗', `"${sg.name}" — ${sg.members?.length || '?'} members`);
    });
    log('👀', 'CHECK BROWSER — sub-groups should show with blue 🏗️ icon and "MATCH" badge');
  } else {
    log('⚠️', 'No sub-groups created yet. This could mean:');
    log('  ', '- No projects are published on the platform that match the requirements');
    log('  ', '- The lead matching NLP didn\'t extract from the messages');
    log('  ', '- Check if you have published projects in Manish Nagar / Wardha Road');
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 7: Test Leave Functionality
// ═══════════════════════════════════════════════════════════
async function step7_TestLeave() {
  stepHeader(7, 'Testing Leave Group');
  await sleep(DELAY);

  // Try to leave universal group (should FAIL)
  if (universalGroupId) {
    const token = Object.values(tokens)[0];
    if (!token) { log('⏭️', 'No token available'); return; }
    const leaveUG = await api('POST', `/api/group-chat/rooms/${universalGroupId}/leave`, null, token);
    if (leaveUG.error) {
      log('✅', `Cannot leave universal group: "${leaveUG.error}" (correct!)`);
    } else {
      log('❌', 'Should NOT be able to leave universal group!');
    }
  }

  // Try to leave a sub-group (should SUCCEED)
  const token2Leave = Object.values(tokens)[0];
  if (!token2Leave) { log('⏭️', 'No token'); return; }
  const rooms = await api('GET', '/api/group-chat/rooms', null, token2Leave);
  const subGroup = rooms.myRooms?.find(r => r.isAutoCreated);

  if (subGroup) {
    await sleep(DELAY);
    const leaveResult = await api('POST', `/api/group-chat/rooms/${subGroup._id}/leave`, null, token2Leave);
    if (leaveResult.message) {
      log('✅', `Left sub-group "${subGroup.name}" successfully`);
      log('👀', 'CHECK BROWSER — the sub-group should disappear from Rahul\'s list');
    } else {
      log('❌', `Leave failed: ${leaveResult.error}`);
    }
  } else {
    log('⏭️', 'No sub-group to leave (none were created)');
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        LIVE DEMO — Watch in Browser!                        ║');
  console.log('║                                                              ║');
  console.log('║  Open: http://localhost:3000/dashboard/group-chat            ║');
  console.log('║  Login: 9933000001 / 1234                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  log('🚀', `Connecting to server at ${BASE_URL}`);

  // Check server is running
  try {
    const health = await fetch(`${BASE_URL}/api/auth/session`, { headers: {} });
    if (health.status === 401 || health.status === 200) {
      log('✅', 'Server is running!');
    }
  } catch (err) {
    log('❌', `Server not reachable at ${BASE_URL}`);
    log('💡', 'Start your backend: cd HIT_Backend && node server.js');
    process.exit(1);
  }

  await step1_RegisterUsers();
  await step2_VerifyUniversalGroup();
  await step3_PostMessages();
  await step4_PostRequirements();
  await step5_PostCards();
  await step6_VerifySubGroups();
  await step7_TestLeave();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    DEMO COMPLETE!                            ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Check your browser now:                                     ║');
  console.log('║                                                              ║');
  console.log('║  1. "HIT Community" group with all messages                  ║');
  console.log('║  2. Requirement cards (orange) and Inventory cards (green)   ║');
  console.log('║  3. Auto-created sub-groups (blue 🏗️ icon, "MATCH" badge)   ║');
  console.log('║  4. Project details banner in sub-groups                     ║');
  console.log('║                                                              ║');
  console.log('║  Login as different users to see their perspective:          ║');
  console.log('║    • 9933000001 / 1234 — Demo Admin (Captain)               ║');
  console.log('║    • 9933000002 / 1234 — Rahul Agent                        ║');
  console.log('║    • 9933000003 / 1234 — Priya Agent                        ║');
  console.log('║    • 9933000004 / 1234 — Sai Builders                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
}

run().catch(err => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
