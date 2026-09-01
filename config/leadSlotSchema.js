/**
 * leadSlotSchema
 *
 * Declarative definition of the AI Lead Matching conversation (Approach A —
 * deterministic slot filling, NO LLM). Single source of truth for:
 *   - which questions to ask
 *   - the order of questions
 *   - the input control (template) for each question
 *   - validation rules
 *   - conditional branching (per intent AND per prior answers)
 *
 * BUY / RENT use a lightweight requirement flow.
 * SELL uses a richer, listing-oriented flow that mirrors the project upload
 * form (category → detailed property type → configuration → status → RERA →
 * amenities → price → contact). Optional listing details are SKIPPABLE.
 *
 * Slot shape:
 * {
 *   id, inputType: 'choice'|'number'|'text'|'location'|'phone'|'multichoice',
 *   required: boolean,
 *   skippable?: boolean,              // user may tap "Skip" (optional detail)
 *   question: { en, hi },             // default text (fallback)
 *   questionByIntent?: { sell|buy|rent: {en,hi} },
 *   options?: Array<{ value, label:{en,hi} }>,
 *   optionsByAnswer?: { <depSlotId>: { <value>: options[] } }, // dynamic options
 *   unit?: string[], min?, max?,
 *   prefillFromProfile?: 'phone',
 *   appliesToIntent?: string[],       // slot only applies for these intents
 *   branchIf?: { <slotId>: value|value[] },
 * }
 */

const INTENTS = ['sell', 'buy', 'rent'];

const SKIP_VALUE = '__skipped__';

// ─── Detailed property types per category (mirrors propertyConfig.ts) ────────
const CATEGORY_TYPES = {
  Residential: [
    'Apartment / Flat', 'Villa', 'Independent House', 'Row House', 'Township',
    'Residential Plot', 'Farm House', 'Farm Land', 'Studio Apartment',
    'Penthouse', 'Duplex', 'Serviced Apartment', 'Other'
  ],
  Commercial: [
    'Office Space', 'Retail', 'Showroom', 'Commercial Plot / Land', 'Industry',
    'Co-working Space', 'Warehouse / Storage', 'Hospitality', 'Other'
  ],
  'Mixed Use': [
    'Residential + Retail', 'Residential + Office', 'Residential + Commercial Complex',
    'Mixed-Use Tower', 'Mixed-Use Township', 'Residential + Hospitality',
    'Residential + Commercial Plot', 'Integrated Development', 'Other'
  ]
};

// Build { category: [{value,label}] } for the detailed sell propertyType slot.
const sellPropertyTypeOptionsByCategory = Object.fromEntries(
  Object.entries(CATEGORY_TYPES).map(([cat, list]) => [
    cat,
    list.map((t) => ({ value: t, label: { en: t, hi: t } }))
  ])
);

// A curated short amenities list for the chat (full 60+ list lives on the form).
const KEY_AMENITIES = [
  'Lift', 'Parking', 'Power Backup', 'Security', 'Gym', 'Swimming Pool',
  'Garden', 'Club House', 'Gated Community', 'CCTV Surveillance',
  "Children Play Area", '24x7 Water Supply'
].map((a) => ({ value: a, label: { en: a, hi: a } }));

const slots = [
  // ─── 1. Intent (always first) ─────────────────────────────────────────────
  {
    id: 'intent',
    inputType: 'choice',
    required: true,
    question: { en: 'What would you like to do?', hi: 'Aap kya karna chahte hain?' },
    options: [
      { value: 'sell', label: { en: 'Sell a property', hi: 'Property bechni hai' } },
      { value: 'buy', label: { en: 'Buy a property', hi: 'Property chahiye' } },
      { value: 'rent', label: { en: 'Rent (give / take)', hi: 'Rent pe dena / lena' } }
    ]
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SELL-ONLY: category (drives the detailed property-type list)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'category',
    inputType: 'choice',
    required: true,
    appliesToIntent: ['sell'],
    question: {
      en: 'What category is your property?',
      hi: 'Aapki property kis category ki hai?'
    },
    options: [
      { value: 'Residential', label: { en: 'Residential', hi: 'Residential' } },
      { value: 'Commercial', label: { en: 'Commercial', hi: 'Commercial' } },
      { value: 'Mixed Use', label: { en: 'Mixed Use', hi: 'Mixed Use' } }
    ]
  },

  // SELL-ONLY: detailed property type (options depend on the chosen category)
  {
    id: 'propertyTypeDetailed',
    inputType: 'choice',
    required: true,
    appliesToIntent: ['sell'],
    question: {
      en: 'What type of property is it?',
      hi: 'Property ka type kya hai?'
    },
    optionsByAnswer: { category: sellPropertyTypeOptionsByCategory }
  },

  // ─── 2. Property type (BUY / RENT — simple list) ──────────────────────────
  {
    id: 'propertyType',
    inputType: 'choice',
    required: true,
    appliesToIntent: ['buy', 'rent'],
    question: { en: 'What type of property is it?', hi: 'Kis type ki property hai?' },
    questionByIntent: {
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

  // ─── 3. BHK ───────────────────────────────────────────────────────────────
  // BUY/RENT: built residential (flat/villa). SELL: built residential detailed types.
  {
    id: 'bhk',
    inputType: 'choice',
    required: true,
    branchIf: {
      propertyType: ['flat', 'villa'],
      propertyTypeDetailed: ['Apartment / Flat', 'Villa', 'Independent House', 'Row House', 'Studio Apartment', 'Penthouse', 'Duplex', 'Serviced Apartment']
    },
    branchMatch: 'any', // matches if EITHER propertyType or propertyTypeDetailed qualifies
    question: { en: 'How many BHK?', hi: 'Kitne BHK ka hai?' },
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

  // ─── 4. Area ────────────────────────────────────────────────────────────
  {
    id: 'area',
    inputType: 'number',
    required: true,
    unit: ['sqft', 'acres'],
    min: 1,
    max: 10000000,
    question: { en: 'What is the area?', hi: 'Area kitna hai?' },
    questionByIntent: {
      sell: { en: 'What is the area?', hi: 'Area / size kitna hai?' },
      buy: { en: 'What area (size) do you want?', hi: 'Kitna area chahiye?' },
      rent: { en: 'What is the area?', hi: 'Area kitna hai?' }
    }
  },

  // ─── 5. Location ──────────────────────────────────────────────────────────
  {
    id: 'location',
    inputType: 'location',
    required: true,
    question: { en: 'Which area / locality?', hi: 'Location / area batayein' },
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
    question: { en: 'Which city?', hi: 'Kaunsa sheher?' }
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SELL-ONLY: project/possession status
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'projectStatus',
    inputType: 'choice',
    required: false,
    skippable: true,
    appliesToIntent: ['sell'],
    question: { en: 'What is the construction status?', hi: 'Construction status kya hai?' },
    options: [
      { value: 'ready-to-move', label: { en: 'Ready to move', hi: 'Ready to move' } },
      { value: 'under-construction', label: { en: 'Under construction', hi: 'Under-construction' } },
      { value: 'pre-launch', label: { en: 'Pre-launch', hi: 'Pre-launch' } }
    ]
  },

  // ─── 7. Possession (BUY/RENT built units) ─────────────────────────────────
  {
    id: 'possession',
    inputType: 'choice',
    required: false,
    skippable: true,
    appliesToIntent: ['buy', 'rent'],
    branchIf: { propertyType: ['flat', 'villa', 'shop', 'office'] },
    question: { en: 'Ready to move or under construction?', hi: 'Ready hai ya under-construction?' },
    questionByIntent: {
      buy: { en: 'Do you want ready to move or under construction?', hi: 'Ready chahiye ya under-construction chalega?' },
      rent: { en: 'Ready to move or under construction?', hi: 'Ready hai ya under-construction?' }
    },
    options: [
      { value: 'ready', label: { en: 'Ready to move', hi: 'Ready to move' } },
      { value: 'under_construction', label: { en: 'Under construction', hi: 'Under-construction' } }
    ]
  },

  // ─── 8. Expected price / budget / rent ─────────────────────────────────────
  {
    id: 'expectedPrice',
    inputType: 'number',
    required: true,
    unit: ['lakh', 'cr'],
    min: 1,
    max: 1000000,
    question: { en: 'What is the expected price?', hi: 'Expected price kya hai?' },
    questionByIntent: {
      sell: { en: 'What is your expected price?', hi: 'Aapki expected price kya hai?' },
      buy: { en: 'What is your budget?', hi: 'Aapka budget kitna hai?' },
      rent: { en: 'What is the expected rent?', hi: 'Expected rent kitna hai?' }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SELL-ONLY: RERA + bank loan + key amenities (all skippable)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'reraApproved',
    inputType: 'choice',
    required: false,
    skippable: true,
    appliesToIntent: ['sell'],
    question: { en: 'Is it RERA approved?', hi: 'Kya ye RERA approved hai?' },
    options: [
      { value: 'yes', label: { en: 'Yes', hi: 'Haan' } },
      { value: 'no', label: { en: 'No', hi: 'Nahi' } }
    ]
  },
  {
    id: 'reraNumber',
    inputType: 'text',
    required: false,
    skippable: true,
    appliesToIntent: ['sell'],
    branchIf: { reraApproved: ['yes'] },
    question: { en: 'What is the RERA number?', hi: 'RERA number kya hai?' }
  },
  {
    id: 'bankLoanAvailable',
    inputType: 'choice',
    required: false,
    skippable: true,
    appliesToIntent: ['sell'],
    question: { en: 'Is bank loan available on this property?', hi: 'Is property pe bank loan available hai?' },
    options: [
      { value: 'yes', label: { en: 'Yes', hi: 'Haan' } },
      { value: 'no', label: { en: 'No', hi: 'Nahi' } }
    ]
  },
  {
    id: 'amenities',
    inputType: 'multichoice',
    required: false,
    skippable: true,
    appliesToIntent: ['sell'],
    question: { en: 'Select key amenities (optional).', hi: 'Key amenities chunein (optional).' },
    options: KEY_AMENITIES
  },

  // ─── 9. Urgency (all intents, optional & skippable) ────────────────────────
  {
    id: 'urgency',
    inputType: 'choice',
    required: false,
    skippable: true,
    question: { en: 'How urgent is it?', hi: 'Kitni jaldi hai?' },
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

  // ─── 10. Contact (always, required) ────────────────────────────────────────
  {
    id: 'contact',
    inputType: 'phone',
    required: true,
    prefillFromProfile: 'phone',
    question: { en: 'Please confirm the contact number.', hi: 'Contact number confirm karein.' }
  }
];

const slotsById = slots.reduce((acc, s) => { acc[s.id] = s; return acc; }, {});

module.exports = {
  INTENTS,
  SKIP_VALUE,
  CATEGORY_TYPES,
  slots,
  slotsById
};
