/**
 * leadChatPhrasings
 *
 * Surface-level phrasing variety for the AI Lead Matching chat (Approach A —
 * NO LLM). This adds "human feel" by rotating between several hand-written
 * Hinglish phrasings for each question, plus varied greetings, summaries,
 * results lines, and occasional acknowledgments.
 *
 * IMPORTANT: This ONLY varies wording. It never changes:
 *   - which slot is asked, the order, branching, validation
 *   - option values (only labels/questions vary)
 * So the conversation stays 100% deterministic in behavior; only the text the
 * user reads changes. Randomness = random pick from a curated array.
 *
 * Structure:
 *   questionVariants[slotId][intent] = [ { en, hi }, ... ]   // intent-specific pools
 *   questionVariants[slotId]._any    = [ { en, hi }, ... ]   // used for all intents
 *   acknowledgments[slotId]          = [ hiString, ... ]     // occasional lead-in AFTER answering that slot
 *   greetings / summaryLeads / resultsWithMatches / resultsNoMatch / loopBackPrompts / retryHints
 */

// ─── Question phrasing pools ────────────────────────────────────────────────
// Each pool has 3-5 variants. `_any` applies when there's no intent-specific pool.
const questionVariants = {
  intent: {
    _any: [
      { en: 'What would you like to do?', hi: 'Aap kya karna chahte hain?' },
      { en: 'How can I help you today?', hi: 'Bataiye, aaj main kya help karun?' },
      { en: 'What are you looking to do?', hi: 'Aap kya karna chahenge?' },
      { en: 'Let\'s get started — what do you need?', hi: 'Chaliye shuru karte hain — aapko kya chahiye?' }
    ]
  },

  propertyType: {
    sell: [
      { en: 'What type of property are you selling?', hi: 'Aap kis type ki property bech rahe hain?' },
      { en: 'Which kind of property is it?', hi: 'Property kis type ki hai?' },
      { en: 'What are you putting up for sale?', hi: 'Aap kya bechne wale hain?' }
    ],
    buy: [
      { en: 'What type of property are you looking for?', hi: 'Aap kis type ki property dhoond rahe hain?' },
      { en: 'Which kind of property do you need?', hi: 'Aapko kis type ki property chahiye?' },
      { en: 'What are you planning to buy?', hi: 'Aap kya kharidne ka soch rahe hain?' }
    ],
    rent: [
      { en: 'What type of property is it (for rent)?', hi: 'Rent ke liye kis type ki property hai?' },
      { en: 'Which kind of property for rent?', hi: 'Rent ke liye kaunsi property?' }
    ]
  },

  bhk: {
    sell: [
      { en: 'How many BHK is it?', hi: 'Kitne BHK ka hai?' },
      { en: 'How big is it — how many BHK?', hi: 'Kitne BHK ka hai property?' }
    ],
    buy: [
      { en: 'How many BHK do you want?', hi: 'Kitne BHK chahiye?' },
      { en: 'What configuration are you looking for?', hi: 'Kitne BHK dhoond rahe hain?' },
      { en: 'How many bedrooms do you need?', hi: 'Kitne BHK chahenge aapko?' }
    ],
    _any: [
      { en: 'How many BHK?', hi: 'Kitne BHK ka hai?' }
    ]
  },

  area: {
    buy: [
      { en: 'What area (size) do you want?', hi: 'Kitna area chahiye?' },
      { en: 'Roughly what size are you after?', hi: 'Approx kitna area dekh rahe hain?' }
    ],
    _any: [
      { en: 'What is the area?', hi: 'Area kitna hai?' },
      { en: 'How much is the built-up/plot area?', hi: 'Kitna area hai property ka?' }
    ]
  },

  location: {
    sell: [
      { en: 'Which area / locality is the property in?', hi: 'Property kis area / locality me hai?' },
      { en: 'Where is the property located?', hi: 'Property kahan pe hai?' }
    ],
    buy: [
      { en: 'Which area / locality do you want?', hi: 'Aapko kaunsa area / locality chahiye?' },
      { en: 'Any preferred location?', hi: 'Kaunse area me dhoond rahe hain?' },
      { en: 'Where are you looking?', hi: 'Kahan pe chahiye aapko?' }
    ],
    _any: [
      { en: 'Which area / locality?', hi: 'Location / area batayein' }
    ]
  },

  city: {
    _any: [
      { en: 'Which city?', hi: 'Kaunsa sheher?' },
      { en: 'And the city?', hi: 'Aur sheher kaunsa?' },
      { en: 'Which city is this in?', hi: 'Ye kis sheher me hai?' }
    ]
  },

  expectedPrice: {
    sell: [
      { en: 'What is your expected price?', hi: 'Aapki expected price kya hai?' },
      { en: 'How much are you expecting for it?', hi: 'Kitne me bechna chahte hain?' }
    ],
    buy: [
      { en: 'What is your budget?', hi: 'Aapka budget kitna hai?' },
      { en: 'How much are you planning to spend?', hi: 'Kitne tak ka budget hai?' },
      { en: 'What price range works for you?', hi: 'Kitne tak soch rahe hain?' }
    ],
    rent: [
      { en: 'What is the expected rent?', hi: 'Expected rent kitna hai?' },
      { en: 'What monthly rent are you looking at?', hi: 'Kitna rent soch rahe hain?' }
    ]
  },

  possession: {
    buy: [
      { en: 'Do you want ready to move or under construction?', hi: 'Ready chahiye ya under-construction chalega?' },
      { en: 'Ready-to-move or okay with under construction?', hi: 'Ready-to-move ya under-construction bhi chalega?' }
    ],
    _any: [
      { en: 'Ready to move or under construction?', hi: 'Ready hai ya under-construction?' }
    ]
  },

  urgency: {
    sell: [
      { en: 'How soon do you want to sell?', hi: 'Kitni jaldi bechna hai?' },
      { en: 'What\'s your timeline to sell?', hi: 'Kitne time me bechna chahte hain?' }
    ],
    buy: [
      { en: 'How soon do you want to buy?', hi: 'Kitni jaldi kharidna hai?' },
      { en: 'What\'s your timeline?', hi: 'Kitne time me chahiye?' }
    ],
    _any: [
      { en: 'How urgent is it?', hi: 'Kitni jaldi hai?' }
    ]
  },

  contact: {
    _any: [
      { en: 'Please confirm the contact number.', hi: 'Contact number confirm karein.' },
      { en: 'Last one — your contact number?', hi: 'Aakhri sawal — aapka contact number?' },
      { en: 'A number to reach you on?', hi: 'Aapse contact karne ke liye number?' }
    ]
  }
};

// ─── Acknowledgments (occasional inline lead-in for the NEXT question) ───────
// Keyed by the slot that was JUST answered. Used ~50% of the time so it stays
// human, not repetitive. `{v}` is replaced with the user's answer display.
const acknowledgments = {
  intent: ['Great!', 'Perfect.', 'Theek hai.', 'Chaliye!'],
  propertyType: ['Nice.', 'Achha.', 'Got it.', 'Samajh gaya.'],
  bhk: ['Cool.', 'Theek hai.', 'Noted.'],
  location: ['{v}, badhiya area!', '{v} — noted.', 'Achha, {v}.', 'Great choice.'],
  city: ['Perfect.', 'Theek hai.', 'Noted.'],
  expectedPrice: ['Got it.', 'Theek hai.', 'Noted.'],
  area: ['Noted.', 'Theek hai.'],
  possession: ['Okay.', 'Samajh gaya.'],
  urgency: ['Understood.', 'Theek hai.']
};

// ─── Greetings ───────────────────────────────────────────────────────────────
const greetings = [
  'Namaste! Main aapki lead matching me help karunga. Bas tap karke jawab dein.',
  'Hello! Chaliye aapke liye best matches dhoondte hain. Neeche tap karke shuru karein.',
  'Namaste! Kuch quick sawaalon ke baad main aapko matches dikha dunga. Shuru karein?',
  'Hi! Main HIT Assistant hoon. Bas tap karke jawab dijiye, main aapki help karta hoon.'
];

// ─── Summary lead-in (prefix before the summary card content) ────────────────
const summaryLeads = [
  'Bas ho gaya! Ek baar confirm kar lein:',
  'Perfect, sab mil gaya. Zara check kar lijiye:',
  'Great! Ye rahi aapki details — confirm karein:',
  'Almost done! Neeche details dekh lein:'
];

// ─── Results lines ───────────────────────────────────────────────────────────
const resultsWithMatches = [
  'Mil gaye! {n} matching {noun}.',
  'Badhiya! Aapke liye {n} {noun} mile.',
  '{n} {noun} mil gaye jo fit ho sakte hain.',
  'Ye dekhiye — {n} matching {noun}.'
];

const resultsNoMatch = [
  'Abhi koi exact match nahi mila. Aapki lead save ho gayi hai, match milte hi bata denge.',
  'Filhaal koi match nahi mila, par tension nahi — lead save hai, naya match aate hi update karenge.',
  'Is waqt koi matching property nahi mili. Lead safe hai, milte hi aapko inform karenge.'
];

// ─── Loop-back prompts (start another lead) ──────────────────────────────────
const loopBackPrompts = [
  'Kuch aur? Bechna / Kharidna / Rent — batayein.',
  'Ek aur lead add karni hai? Neeche se chunein.',
  'Aur koi requirement? Shuru karein.',
  'Chaliye agli lead — kya karna hai?'
];

// ─── Closing messages (warm wrap-up AFTER results, no question) ──────────────
// Neutral tone — does not promise a specific human follow-up.
const closings = [
  'Ho gaya! Aapki lead save ho gayi hai. Naye matches aate hi aapko update milta rahega.',
  'Bas ho gaya — lead safe hai aur matches ready hain. Aapko updates milte rahenge.',
  'Perfect, sab set hai! Aapki lead save ho chuki hai. Koi acha match aate hi aapko pata chal jayega.',
  'Done! Details save ho gayin. Aap jab chahein neeche se aage badh sakte hain.'
];

// ─── Retry hints (varied polite corrections) ─────────────────────────────────
const retryHints = {
  choice: ['Diye gaye options me se ek chunein.', 'Neeche diye options me se select karein please.'],
  number: ['Ek valid number daaliye.', 'Sahi number enter karein please.'],
  phone: ['10-digit mobile number daaliye.', 'Ek valid 10-digit number enter karein.'],
  text: ['Ye field khaali nahi ho sakta.', 'Kuch to bataiye is field me.']
};

// ─── Random helpers ──────────────────────────────────────────────────────────
function pick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Pick a question variant for a slot+intent from the pools.
 * Falls back through: intent pool → _any pool → null (caller falls back to schema).
 * Returns { en, hi } or null.
 */
function pickQuestion(slotId, intent) {
  const pool = questionVariants[slotId];
  if (!pool) return null;
  const list = (intent && pool[intent]) || pool._any || null;
  return pick(list);
}

/**
 * Occasional acknowledgment for the slot just answered. Returns '' most of the
 * time so it doesn't feel spammy. `answerDisplay` fills the {v} placeholder.
 */
function pickAck(answeredSlotId, answerDisplay, probability = 0.5) {
  if (Math.random() > probability) return '';
  const line = pick(acknowledgments[answeredSlotId]);
  if (!line) return '';
  return line.replace('{v}', answerDisplay || '');
}

function pickGreeting() { return pick(greetings); }
function pickSummaryLead() { return pick(summaryLeads); }
function pickLoopBack() { return pick(loopBackPrompts); }
function pickClosing() { return pick(closings); }

function pickResults(count) {
  if (count > 0) {
    const noun = count === 1 ? 'result' : 'results';
    return pick(resultsWithMatches).replace('{n}', count).replace('{noun}', noun);
  }
  return pick(resultsNoMatch);
}

function pickRetryHint(inputType) {
  const key = ['choice', 'number', 'phone'].includes(inputType) ? inputType : 'text';
  return pick(retryHints[key]);
}

module.exports = {
  questionVariants,
  acknowledgments,
  pickQuestion,
  pickAck,
  pickGreeting,
  pickSummaryLead,
  pickLoopBack,
  pickClosing,
  pickResults,
  pickRetryHint,
  pick
};
