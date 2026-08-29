/**
 * PropertyTypeNormalizer
 *
 * Real estate data has property type expressed in several inconsistent ways:
 *   - Legacy Project.projectType: 'flat', 'plot', 'villa', 'commercial', ...
 *   - New Project.category: 'Residential' | 'Commercial' | 'Mixed Use'
 *   - New Project.propertyType (free text label from the upload form):
 *       'Apartment / Flat', 'Villa', 'Residential Plot', 'Commercial Plot / Land',
 *       'Farm House', 'Farm Land', 'Office Space', 'Warehouse / Storage',
 *       'Residential + Retail', 'Mixed-Use Tower', ...
 *   - AI Lead chat values: 'flat', 'plot', 'villa', 'shop', 'office'
 *   - Free-text chat ("2bhk flat", "commercial plot", "farm house")
 *
 * This module maps ANY of those to a canonical { family, category } so the
 * MatchEngine can compare a requirement's type against a project's type
 * consistently, and score partial/related matches instead of hard-filtering.
 *
 * Families (granular, matchable units):
 *   flat, villa, independent_house, row_house, plot, farm_house, farm_land,
 *   penthouse, studio, duplex, township, office, retail, showroom,
 *   commercial_plot, industry, coworking, warehouse, hospitality, mixed_use
 *
 * Categories (top level): residential | commercial | mixed_use
 */

// family → category
const FAMILY_CATEGORY = {
  flat: 'residential',
  villa: 'residential',
  independent_house: 'residential',
  row_house: 'residential',
  penthouse: 'residential',
  studio: 'residential',
  duplex: 'residential',
  township: 'residential',
  plot: 'residential',        // residential plot (default plot meaning)
  farm_house: 'residential',
  farm_land: 'residential',
  serviced_apartment: 'residential',

  office: 'commercial',
  retail: 'commercial',
  showroom: 'commercial',
  commercial_plot: 'commercial',
  industry: 'commercial',
  coworking: 'commercial',
  warehouse: 'commercial',
  hospitality: 'commercial',

  mixed_use: 'mixed_use',

  other: null,
};

// Related families that are "close enough" for a partial-credit match.
// Symmetric groups: a requirement for one gives partial credit to the others.
const RELATED_GROUPS = [
  ['flat', 'studio', 'penthouse', 'duplex', 'serviced_apartment'], // apartment family
  ['villa', 'independent_house', 'row_house', 'duplex'],           // low-rise homes
  ['plot', 'farm_land', 'commercial_plot'],                        // land family
  ['farm_house', 'farm_land'],                                     // farm family
  ['office', 'coworking', 'showroom', 'retail'],                   // workspace/retail
  ['retail', 'showroom'],                                          // storefront
  ['warehouse', 'industry'],                                       // industrial
];

// Keyword → family. Order matters: more specific phrases first.
// Each entry: [regex, family]. Tested against a normalized lowercase string.
const KEYWORD_RULES = [
  // Mixed use (check before residential/commercial keywords)
  [/mixed[\s-]*use|integrated development|resi.*\+.*(retail|office|commercial|hospitality)|residential\s*\+/, 'mixed_use'],

  // Farm
  [/farm\s*house|farmhouse/, 'farm_house'],
  [/farm\s*land|agricultur|krishi/, 'farm_land'],

  // Land / plots (specific before generic 'plot')
  [/commercial\s*(plot|land)|industrial\s*(plot|land)/, 'commercial_plot'],
  [/residential\s*plot|resi.*plot/, 'plot'],
  [/\bplot\b|\bland\b|\bzameen\b|\bzamin\b|\bjameen\b/, 'plot'],

  // Residential dwellings (specific before generic 'apartment/flat')
  [/studio/, 'studio'],
  [/penthouse/, 'penthouse'],
  [/serviced\s*apartment/, 'serviced_apartment'],
  [/apartment|\bflat\b|\bflats\b/, 'flat'],
  [/duplex/, 'duplex'],
  [/row\s*house|rowhouse/, 'row_house'],
  [/independent\s*house|bungalow|\bkothi\b/, 'independent_house'],
  [/\bvilla\b|\bghar\b/, 'villa'],
  [/township/, 'township'],

  // Commercial
  [/co[\s-]*working/, 'coworking'],
  [/office/, 'office'],
  [/showroom/, 'showroom'],
  [/retail|\bshop\b|\bdukaan\b|\bdukan\b|\bstore\b/, 'retail'],
  [/warehouse|storage|godown/, 'warehouse'],
  [/industry|industrial|factory/, 'industry'],
  [/hospitality|hotel|resort|banquet/, 'hospitality'],
];

// Direct value map for known enum-ish inputs (chat values, legacy projectType).
const DIRECT_MAP = {
  flat: 'flat',
  apartment: 'flat',
  villa: 'villa',
  independent_house: 'independent_house',
  row_house: 'row_house',
  rowhouse: 'row_house',
  penthouse: 'penthouse',
  studio: 'studio',
  duplex: 'duplex',
  township: 'township',
  plot: 'plot',
  land: 'plot',
  farm: 'farm_land',
  farmhouse: 'farm_house',
  farm_house: 'farm_house',
  farm_land: 'farm_land',
  shop: 'retail',
  retail: 'retail',
  showroom: 'showroom',
  office: 'office',
  coworking: 'coworking',
  warehouse: 'warehouse',
  industry: 'industry',
  hospitality: 'hospitality',
  commercial: 'office',          // generic 'commercial' legacy → treat as office family (commercial category)
  commercial_plot: 'commercial_plot',
  mixed_use: 'mixed_use',
};

// Category strings (from Project.category) → canonical category.
const CATEGORY_MAP = {
  residential: 'residential',
  commercial: 'commercial',
  'mixed use': 'mixed_use',
  mixed_use: 'mixed_use',
};

class PropertyTypeNormalizer {
  /**
   * Normalize any property type expression to a canonical descriptor.
   * @param {string} raw - e.g. 'Commercial Plot / Land', 'flat', 'farm house'
   * @returns {{ family: string|null, category: string|null, raw: string }}
   */
  normalize(raw) {
    if (!raw || typeof raw !== 'string') return { family: null, category: null, raw: '' };

    const text = raw.toLowerCase().trim();
    const key = text.replace(/[\s/]+/g, '_').replace(/[^a-z_+]/g, '');

    // 1) Direct enum-style match (chat values, legacy projectType).
    if (DIRECT_MAP[key]) {
      const family = DIRECT_MAP[key];
      return { family, category: FAMILY_CATEGORY[family] || null, raw: text };
    }

    // 2) Keyword rules (handles the rich form labels + free text).
    for (const [re, family] of KEYWORD_RULES) {
      if (re.test(text)) {
        return { family, category: FAMILY_CATEGORY[family] || null, raw: text };
      }
    }

    // 3) Category-only fallback (e.g. project has only category = 'Commercial').
    if (CATEGORY_MAP[text]) {
      return { family: null, category: CATEGORY_MAP[text], raw: text };
    }

    return { family: null, category: null, raw: text };
  }

  /**
   * Resolve a project's canonical type from its (possibly mixed) fields.
   * Prefers the most specific available signal: propertyType → projectType → category.
   * @param {object} project - { projectType, propertyType, category }
   */
  fromProject(project) {
    if (!project) return { family: null, category: null, raw: '' };

    // Most specific first.
    if (project.propertyType) {
      const n = this.normalize(project.propertyType);
      if (n.family || n.category) {
        // If propertyType didn't yield a category but the project has one, fill it.
        if (!n.category && project.category) n.category = this._category(project.category);
        return n;
      }
    }
    if (project.projectType) {
      const n = this.normalize(project.projectType);
      if (n.family || n.category) {
        if (!n.category && project.category) n.category = this._category(project.category);
        return n;
      }
    }
    if (project.category) {
      return { family: null, category: this._category(project.category), raw: String(project.category).toLowerCase() };
    }
    return { family: null, category: null, raw: '' };
  }

  _category(catStr) {
    return CATEGORY_MAP[String(catStr).toLowerCase().trim()] || null;
  }

  /**
   * Score how well a requirement's property type matches a project's.
   * Returns 0..1 (caller scales to points).
   *
   *   1.0  exact family match (flat == flat)
   *   0.7  related family (flat ~ studio, plot ~ farm_land)
   *   0.6  requirement is mixed_use and project category is mixed_use
   *   0.55 project is mixed_use and requirement family fits inside it (partial)
   *   0.5  same category, different family (both residential, flat vs villa)
   *   0.0  different category / no signal
   *
   * When the requirement gives NO property type, returns { score: null } so the
   * caller can treat it as neutral (don't penalize).
   */
  matchScore(reqRaw, project) {
    const req = this.normalize(reqRaw);
    if (!req.family && !req.category) {
      return { score: null, method: 'req_no_type' };
    }

    const proj = this.fromProject(project);
    if (!proj.family && !proj.category) {
      return { score: 0, method: 'proj_no_type' };
    }

    // Mixed use handling.
    if (req.category === 'mixed_use' || req.family === 'mixed_use') {
      if (proj.category === 'mixed_use' || proj.family === 'mixed_use') {
        return { score: 1.0, method: 'mixed_exact' };
      }
      // A mixed-use seeker can accept residential or commercial as a partial fit.
      if (proj.category === 'residential' || proj.category === 'commercial') {
        return { score: 0.5, method: 'mixed_partial' };
      }
      return { score: 0.3, method: 'mixed_loose' };
    }
    // Project is mixed use, requirement is a concrete family that fits inside it.
    if (proj.category === 'mixed_use' || proj.family === 'mixed_use') {
      return { score: 0.55, method: 'proj_mixed_contains' };
    }

    // Exact family.
    if (req.family && proj.family && req.family === proj.family) {
      return { score: 1.0, method: 'family_exact' };
    }

    // Related families.
    if (req.family && proj.family && this._areRelated(req.family, proj.family)) {
      return { score: 0.7, method: 'family_related' };
    }

    // Same category, different family.
    const reqCat = req.category || (req.family ? FAMILY_CATEGORY[req.family] : null);
    const projCat = proj.category || (proj.family ? FAMILY_CATEGORY[proj.family] : null);
    if (reqCat && projCat && reqCat === projCat) {
      return { score: 0.5, method: 'category_match' };
    }

    return { score: 0, method: 'type_mismatch' };
  }

  _areRelated(a, b) {
    return RELATED_GROUPS.some((g) => g.includes(a) && g.includes(b));
  }

  /**
   * Whether a "plot-like"/land requirement (no built-up BHK) — used by the
   * engine to skip BHK scoring for land/plot/farm-land types.
   */
  isLandType(reqRaw) {
    const n = this.normalize(reqRaw);
    return ['plot', 'farm_land', 'commercial_plot'].includes(n.family);
  }
}

module.exports = new PropertyTypeNormalizer();
module.exports.PropertyTypeNormalizer = PropertyTypeNormalizer;
