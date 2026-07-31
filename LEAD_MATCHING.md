# Lead Matching System — Complete Documentation

## Overview

The Lead Matching system automatically captures property requirements from group chat messages, matches them against published inventory, and surfaces intelligence to the admin. Agents and captains chat normally — they don't know the system is running.

---

## Architecture

```
Agent sends message in Group Chat
         │
         ▼
┌─────────────────────────────────────────────┐
│ NLPExtractor                                 │
│  - Detects requirement intent                │
│  - Extracts: BHK, budget, location, etc.     │
│  - Supports: English, Hindi, Marathi         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ LocationNormalizer                            │
│  - Resolves aliases (Manish Nagar road → X)  │
│  - Typo tolerance (manish nagr → X)          │
│  - Geo-proximity (lat/lng radius)            │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ MatchEngineV2                                │
│  - Queries published projects                │
│  - Scores: budget/location/BHK/loan/etc.     │
│  - Returns top 5 matches with scores         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ LeadCaptureService                           │
│  - Persists ExtractedLead in DB              │
│  - Notifies admin (DB + Socket.io)           │
│  - Stores in ConversationContext             │
└─────────────────────────────────────────────┘

         ┌────────────────────────────────────┐
         │ REVERSE MATCHING (on project publish)│
         │  Builder publishes new project       │
         │  → Matches against recent leads      │
         │  → Notifies original agents + admin  │
         └────────────────────────────────────┘
```

---

## What's Been Built

### Backend Services

| Service | File | Purpose |
|---------|------|---------|
| NLPExtractor | `services/NLPExtractor.js` | Regex-based param extraction from free text |
| LocationNormalizer | `services/LocationNormalizer.js` | Fuzzy location resolution with aliases |
| MatchEngineV2 | `services/MatchEngineV2.js` | Project-to-requirement scoring engine |
| LeadCaptureService | `services/LeadCaptureService.js` | Orchestrator: extract → match → persist → notify |
| ConversationContext | `services/ConversationContext.js` | In-memory context for follow-up resolution |
| ReverseMatchService | `services/ReverseMatchService.js` | New project → existing leads matching |

### Models

| Model | File | Purpose |
|-------|------|---------|
| ExtractedLead | `models/ExtractedLead.js` | Persists every auto-detected lead with params, matches, status |

### API Routes

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/lead-matching/extract` | POST | Test NLP extraction (debug) |
| `/api/lead-matching/test-match` | POST | Test extraction + matching (debug) |
| `/api/lead-matching/leads` | GET | Get all leads (paginated, role-filtered) |
| `/api/lead-matching/leads/:id` | GET | Single lead detail |
| `/api/lead-matching/leads/:id/status` | PATCH | Update lead status (confirm/reject/convert) |
| `/api/lead-matching/stats` | GET | Aggregate statistics |

### Frontend

| Component | File | Purpose |
|-----------|------|---------|
| LeadsTab | `group-chat/LeadsTab.tsx` | Lead list with filters, actions, real-time updates |
| StatsTab | `group-chat/StatsTab.tsx` | Metrics dashboard |
| leadMatchingApi | `lib/api.ts` | Frontend API layer |

### Integration Points

| Where | What happens |
|-------|-------------|
| `groupChatController.postMessage` | Text messages trigger LeadCaptureService (REST path) |
| `groupChat.socket.js` → `group_send_message` | Text messages trigger LeadCaptureService (Socket path) |
| `ProjectController.publish` | Published projects trigger ReverseMatchService |
| `internalRoutes` POST/PUT | OneEmployee project sync triggers ReverseMatchService |

---

## Scoring System

### Forward Matching (Requirement → Projects)

| Criteria | Max Points | Logic |
|----------|-----------|-------|
| Budget | 30 | ≤5%=30, ≤10%=26, ≤15%=20, ≤20%=14 |
| Location | 30 | Canonical=30, 2km=28, 5km=20, substring=15, fuzzy=12 |
| BHK | 20 | Exact=20, adjacent (±1)=8 |
| Loan | 8 | Required+available=8, not required=4 |
| Possession | 7 | Timeline matches project status=7 |
| Verified builder | 3 | Bonus |
| RERA approved | 2 | Bonus |
| **Max total** | **100** | Capped |

### Reverse Matching (Project → Leads)

Same scoring as above, plus:
- **Location penalty (-20)**: Applied when lead specifies a location that doesn't match the project. Prevents cross-city false positives.

### Confidence Calibration

- **Golden trio** (BHK + Budget + Location all present): +15% confidence
- Missing BHK + Budget: -15% penalty
- Missing Location + City: -10% penalty
- Budget without BHK or location: -10% penalty (likely noise)

---

## Language Support

### English
- "looking for", "need", "require", "want", "client wants", "buyer for", "anyone has"

### Hindi (Romanized)
- "chahiye", "lena hai", "kharidna hai", "dila do", "ghar chahiye", "makan chahiye"
- "koi flat", "dhundh raha", "dekhna hai"
- Numbers: "do bhk" (2), "teen bhk" (3)
- Location indicators: "ke paas", "mein", "wale area"

### Marathi (Romanized)
- "pahije", "havay", "shodhat aahe", "ghyaycha"
- "flat pahije", "ghar pahije"

### Negative Intent (correctly rejected)
- Greetings: "good morning", "suprabhat", "namaste"
- Status updates: "sold", "booked", "deal done", "bik gaya"
- Thank you, festivals, short acks

---

## Location Coverage (Nagpur)

25+ locations with aliases:
- Manish Nagar (+ road, extension, ext, near, behind, nagr typo)
- Wardha Road (+ rd, wardha rd)
- Besa (+ road, square)
- Pratap Nagar (+ pratapnagar)
- Manewada (+ road, ring road, maneywada)
- Dharampeth (+ ext)
- Civil Lines (+ civillines)
- Hingna (+ road, MIDC)
- Koradi (+ road)
- Katol Road (+ rd)
- And more: Sadar, Sitabuldi, Ramdaspeth, Somalwada, Hudkeshwar, Wadi, Nandanvan, Seminary Hills, Bajaj Nagar, Laxmi Nagar, Trimurti Nagar

Each location has approximate center coordinates for geo-proximity matching.

---

## Test Results

### NLP Extraction: 111 tests, 100% pass rate
- English intent detection: 8/8
- Hindi intent detection: 8/8
- Marathi intent detection: 4/4
- Negative intent (false positive prevention): 10/10
- BHK extraction: 9/9
- Budget extraction: 12/12
- Location normalization: 12/12
- Same area detection: 6/6
- Multi-location detection: 3/3
- Multi-requirement detection: 4/4
- Follow-up resolution: 5/5
- Message deduplication: 4/4
- Property type: 8/8
- Possession/Loan/Urgency: 9/9
- Confidence calibration: 3/3
- Real-world messages (E2E): 6/6

### Reverse Matching: 45 tests, 100% pass rate
- Perfect matches (high score): 5/5
- Budget scoring: 5/5
- Location scoring: 5/5
- BHK scoring: 4/4
- Possession scoring: 4/4
- Loan + bonus scoring: 6/6
- No-match scenarios: 4/4
- Batch scoring: 4/4
- Score breakdown decomposition: 3/3
- Edge cases: 5/5

---

## Gaps & Limitations

| Gap | Impact | Effort |
|-----|--------|--------|
| Nagpur-only location aliases | Other city locations won't fuzzy-match | Medium |
| No lead detail panel in UI | Admin can't see matched projects on click | Small |
| No lead-to-DealRoom conversion in UI | Can't directly create deal from confirmed lead | Small |
| Rule-based confidence (no ML) | No automatic improvement from admin feedback | Medium |
| No OCR / image extraction | Requirement screenshots are missed | Large |
| No voice message transcription | Audio messages missed | Large |
| No project UPDATE re-matching | Price changes don't trigger re-match | Small |
| No "assign to agent" action | Admin can't delegate follow-up | Small |
| Basic stats (no charts) | No time-series or trend visualization | Medium |
| No export/download of leads | Can't extract to CSV/Excel | Small |

---

## Real-World Confidence

| Aspect | Confidence |
|--------|-----------|
| Detecting explicit requirements | 85-90% |
| Rejecting noise/greetings | 95%+ |
| Location matching (Nagpur) | 90%+ |
| Location matching (other cities) | 40-50% |
| Budget parsing | 95%+ |
| Hindi/Marathi detection | 80-85% |
| Match scoring accuracy | 85% |
| Admin notification reliability | 95% |
| Data persistence (no loss) | 99% |

**Biggest risk**: False positives in early days. "I showed a 2bhk in Manish Nagar today" might trigger extraction. Admin rejection handles this but doesn't feed back yet.

---

## What's Next (Priority Order)

### P0 — Before Production
1. Test with 1 week of real chat data
2. Add lead detail panel (click → see matched projects)
3. Real-time socket updates on Leads tab ✅ DONE

### P1 — First Improvement Cycle
4. Convert-to-Deal flow (confirmed lead → DealRoom)
5. Expand location map (more cities)
6. Project update re-matching hook
7. Assign-to-agent action

### P2 — After Data Collection (1-2 months)
8. Feedback loop (confirmed/rejected → weight adjustment)
9. Agent leaderboard & demand heatmap
10. Time-series analytics + charts

### P3 — Advanced (3-6 months)
11. LLM-powered extraction (replace regex with small model)
12. Voice message transcription
13. Predictive matching (proactive inventory suggestions)

---

## How to Run Tests

```bash
# NLP accuracy tests (no DB needed)
node scripts/test-nlp-accuracy.js

# Reverse matching tests (no DB needed)
node scripts/test-reverse-matching.js

# E2E integration test (needs MongoDB)
node scripts/test-e2e-lead-matching.js

# Seed real data for frontend testing
node scripts/seed-real-leads.js

# Clean seeded data
node scripts/seed-real-leads.js --clean
```

---

## Git Branches

| Branch | Contents |
|--------|----------|
| `feat/captain-portal` | Base NLP matching, LocationNormalizer, MatchEngineV2, ExtractedLead, routes, seed |
| `feat/advanced-nlp-lead-matching` | Hindi/Marathi, multi-req, context, dedup, confidence calibration |
| `feat/reverse-matching` | ReverseMatchService, project publish hooks, E2E test |
