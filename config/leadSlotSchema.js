/**
 * leadSlotSchema
 *
 * Declarative definition of the AI Lead Matching conversation (Approach A —
 * deterministic slot filling, NO LLM). This is the single source of truth for:
 *   - which questions to ask
 *   - the order of questions
 *   - the input control (template) for each question
 *   - validation rules
 *   - conditional branching (which slots apply for a given intent / prior answers)
 *
 * The LeadFlowEngine consumes this schema; adding, removing, or reordering a
 * question is a config change here, not a code change.
 *
 * Slot shape:
 * {
 *   id: string,                       // unique slot id
 *   inputType: 'choice'|'number'|'text'|'location'|'phone',
 *   required: boolean,
 *   question: { en, hi },             // default bilingual question text (fallback)
 *   questionByIntent?: { sell|buy|rent: { en, hi } }, // intent-specific wording (overrides question)
 *   options?: Array<{ value, label:{en,hi} }>,   // for 'choice'
 *   unit?: string[],                  // for 'number' (unit toggle)
 *   min?, max?: number,               // for 'number' validation
 *   prefillFromProfile?: 'phone',     // prefill hint for frontend
 *   appliesToIntent?: string[],       // if set, slot only applies for these intents
 *   branchIf?: { <slotId>: value|value[] }, // slot only applies when prior answers match
 * }
 */

const INTENTS = ['sell', 'buy', 'rent'];

const slots = [
  // ─── 1. Intent (always first) ───────────────────────────────────────────
  {
    id: 'intent',
    inputType: 'choice',
    required: true,
    question: {
      en: 'What would you like to do?',
      hi: 'Aap kya karna chahte hain?'
    },
    options: [
      { value: 'sell', label: { en: 'Sell a property', hi: 'Property bechni hai' } },
      { value: 'buy', label: { en: 'Buy a property', hi: 'Property chahiye' } },
      { value: 'rent', label: { en: 'Rent (give / take)', hi: 'Rent pe dena / lena' } }
    ]
  },

  // ─── 2. Property type ─────────────────────────────────────────────────────
  {
    id: 'propertyType',
    inputType: 'choice',
    required: true,
    question: {
      en: 'What type of property is it?',
      hi: 'Kis type ki property hai?'
    },
    questionByIntent: {
      sell: { en: 'What type of property are you selling?', hi: 'Aap kis type ki property bech rahe hain?' },
      buy: { en: 'What type of property are you looking for?', hi: 'Aap kis type ki property dhoond rahe hain?' },
      rent: { en: 'What type of property is it (for rent)?', hi: 'Rent ke liye kis type ki property hai?' }
    },
    options: [
      { value: 'flat', label: { en: 'Flat / Apartment', hi: 'Flat / Apartment' } },
      { value: 'plot', label: { en: 'Plot / Land', hi: 'Plot / Zameen' } },
      { value: 'villa', label: { en: 'Villa / House', hi: 'Villa / Ghar' } },
      { value: 'shop', label: { en: 'Shop', hi: 'Shop / Dukaan' } },
      { value: 'office', label: { en: 'Office', hi: 'Office' } }
    ]
  },

  // ─── 3. BHK (only for residential built units) ────────────────────────────
  {
    id: 'bhk',
    inputType: 'choice',
    required: true,
    branchIf: { propertyType: ['flat', 'villa'] }, // skipped for plot / shop / office
    question: {
      en: 'How many BHK?',
      hi: 'Kitne BHK ka hai?'
    },
    questionByIntent: {
      sell: { en: 'How many BHK is it?', hi: 'Kitne BHK ka hai?' },
      buy: { en: 'How many BHK do you want?', hi: 'Kitne BHK chahiye?' },
      rent: { en: 'How many BHK?', hi: 'Kitne BHK ka hai?' }
    },
    options: [
      { value: '1BHK', label: { en: '1 BHK', hi: '1 BHK' } },
      { value: '2BHK', label: { en: '2 BHK', hi: '2 BHK' } },
      { value: '3BHK', label: { en: '3 BHK', hi: '3 BHK' } },
      { value: '4BHK+', label: { en: '4 BHK or more', hi: '4 BHK ya zyada' } }
    ]
  },

  // ─── 4. Area ──────────────────────────────────────────────────────────────
  {
    id: 'area',
    inputType: 'number',
    required: true,
    unit: ['sqft', 'acres'],
    min: 1,
    max: 10000000,
    question: {
      en: 'What is the area?',
      hi: 'Area kitna hai?'
    },
    questionByIntent: {
      sell: { en: 'What is the area?', hi: 'Area kitna hai?' },
      buy: { en: 'What area (size) do you want?', hi: 'Kitna area chahiye?' },
      rent: { en: 'What is the area?', hi: 'Area kitna hai?' }
    }
  },

  // ─── 5. Location ──────────────────────────────────────────────────────────
  {
    id: 'location',
    inputType: 'location',
    required: true,
    question: {
      en: 'Which area / locality?',
      hi: 'Location / area batayein'
    },
    questionByIntent: {
      sell: { en: 'Which area / locality is the property in?', hi: 'Property kis area / locality me hai?' },
      buy: { en: 'Which area / locality do you want?', hi: 'Aapko kaunsa area / locality chahiye?' },
      rent: { en: 'Which area / locality?', hi: 'Kaunsa area / locality?' }
    }
  },

  // ─── 6. City ────────────────────────────────────────────────────────────
  {
    id: 'city',
    inputType: 'text',
    required: true,
    question: {
      en: 'Which city?',
      hi: 'Kaunsa sheher?'
    }
  },

  // ─── 7. Expected price ─────────────────────────────────────────────────────
  {
    id: 'expectedPrice',
    inputType: 'number',
    required: true,
    unit: ['lakh', 'cr'],
    min: 1,
    max: 1000000,
    question: {
      en: 'What is the expected price?',
      hi: 'Expected price kya hai?'
    },
    questionByIntent: {
      sell: { en: 'What is your expected price?', hi: 'Aapki expected price kya hai?' },
      buy: { en: 'What is your budget?', hi: 'Aapka budget kitna hai?' },
      rent: { en: 'What is the expected rent?', hi: 'Expected rent kitna hai?' }
    }
  },

  // ─── 8. Possession (built units only) ─────────────────────────────────────
  {
    id: 'possession',
    inputType: 'choice',
    required: false,
    branchIf: { propertyType: ['flat', 'villa', 'shop', 'office'] }, // not for plot
    question: {
      en: 'Ready to move or under construction?',
      hi: 'Ready hai ya under-construction?'
    },
    questionByIntent: {
      sell: { en: 'Is it ready to move or under construction?', hi: 'Ready hai ya under-construction?' },
      buy: { en: 'Do you want ready to move or under construction?', hi: 'Ready chahiye ya under-construction chalega?' },
      rent: { en: 'Ready to move or under construction?', hi: 'Ready hai ya under-construction?' }
    },
    options: [
      { value: 'ready', label: { en: 'Ready to move', hi: 'Ready to move' } },
      { value: 'under_construction', label: { en: 'Under construction', hi: 'Under-construction' } }
    ]
  },

  // ─── 9. Urgency ──────────────────────────────────────────────────────────
  {
    id: 'urgency',
    inputType: 'choice',
    required: false,
    question: {
      en: 'How urgent is it?',
      hi: 'Kitni jaldi hai?'
    },
    questionByIntent: {
      sell: { en: 'How soon do you want to sell?', hi: 'Kitni jaldi bechna hai?' },
      buy: { en: 'How soon do you want to buy?', hi: 'Kitni jaldi kharidna hai?' },
      rent: { en: 'How urgent is it?', hi: 'Kitni jaldi hai?' }
    },
    options: [
      { value: 'normal', label: { en: 'Normal', hi: 'Normal' } },
      { value: 'urgent', label: { en: 'Urgent', hi: 'Urgent' } },
      { value: 'very_urgent', label: { en: 'Very urgent', hi: 'Bahut urgent' } }
    ]
  },

  // ─── 10. Contact ──────────────────────────────────────────────────────────
  {
    id: 'contact',
    inputType: 'phone',
    required: true,
    prefillFromProfile: 'phone',
    question: {
      en: 'Please confirm the contact number.',
      hi: 'Contact number confirm karein.'
    }
  }
];

// Index slots by id for O(1) lookup by the engine.
const slotsById = slots.reduce((acc, s) => {
  acc[s.id] = s;
  return acc;
}, {});

module.exports = {
  INTENTS,
  slots,
  slotsById
};
