const mongoose = require('mongoose');
const Project = require('../models/Project');

/**
 * InventoryService
 * ----------------
 * Single source of truth for all project inventory count arithmetic.
 *
 * Design principles:
 *  - All count math lives here (no scattered $inc across controllers).
 *  - Never goes negative (availableUnits/soldUnits clamped at 0).
 *  - Totals (project.inventory.totalUnits etc.) are always recomputed
 *    from the unitTypes[] breakdown so the summary can never drift.
 *  - Unit-type resolution is fuzzy/forgiving (case + spacing insensitive).
 *
 * Start-simple scope: only closed_won moves inventory (sellUnit).
 * bookUnit / releaseUnit are provided as stubs for a future booking
 * lifecycle so callers can be wired now without a later refactor.
 */
class InventoryService {
  /**
   * Normalize a unit-type label for matching (e.g. "2 bhk" ~ "2BHK").
   */
  _normalize(label) {
    if (!label) return '';
    return String(label).toLowerCase().replace(/\s+/g, '').trim();
  }

  /**
   * Find the unitTypes[] sub-doc that best matches the requested label.
   * Returns the matched sub-doc, or null when it can't be resolved.
   */
  _resolveUnitType(project, requestedLabel) {
    const unitTypes = project.inventory?.unitTypes || [];
    if (unitTypes.length === 0) return null;

    // If there's exactly one unit type, it's unambiguous — use it.
    if (unitTypes.length === 1) return unitTypes[0];

    if (!requestedLabel) return null;

    const target = this._normalize(requestedLabel);

    // Exact normalized match first.
    let match = unitTypes.find((ut) => this._normalize(ut.label) === target);
    if (match) return match;

    // Fallback: partial contains (e.g. requested "2BHK" vs label "2 BHK Deluxe").
    match = unitTypes.find(
      (ut) => this._normalize(ut.label).includes(target) || target.includes(this._normalize(ut.label))
    );
    return match || null;
  }

  /**
   * Recompute rolled-up totals from the unitTypes[] breakdown.
   * Mutates the given inventory object in place and returns it.
   */
  recomputeTotals(inventory) {
    const unitTypes = inventory.unitTypes || [];
    inventory.totalUnits = unitTypes.reduce((s, u) => s + (u.totalUnits || 0), 0);
    inventory.availableUnits = unitTypes.reduce((s, u) => s + (u.availableUnits || 0), 0);
    inventory.bookedUnits = unitTypes.reduce((s, u) => s + (u.bookedUnits || 0), 0);
    inventory.soldUnits = unitTypes.reduce((s, u) => s + (u.soldUnits || 0), 0);
    inventory.lastUpdatedAt = new Date();
    return inventory;
  }

  /**
   * Ensure every unit type has sane derived counts. Used when a builder
   * sets up / edits inventory: if only totalUnits is given, availableUnits
   * defaults to the remainder after booked+sold.
   */
  normalizeUnitTypes(unitTypes = []) {
    return unitTypes.map((ut) => {
      const total = Math.max(0, Number(ut.totalUnits) || 0);
      const sold = Math.max(0, Number(ut.soldUnits) || 0);
      const booked = Math.max(0, Number(ut.bookedUnits) || 0);
      // If availableUnits wasn't explicitly provided, derive it.
      let available =
        ut.availableUnits === undefined || ut.availableUnits === null
          ? total - sold - booked
          : Number(ut.availableUnits);
      available = Math.max(0, available);
      return {
        label: ut.label,
        totalUnits: total,
        availableUnits: available,
        bookedUnits: booked,
        soldUnits: sold,
        pricePerUnit: Math.max(0, Number(ut.pricePerUnit) || 0)
      };
    });
  }

  /**
   * Set / replace a project's full inventory (builder setup or correction).
   * @returns the updated project document.
   */
  async setInventory(projectId, unitTypes = []) {
    const project = await Project.findById(projectId);
    if (!project) throw new Error('Project not found');

    project.inventory = project.inventory || {};
    project.inventory.unitTypes = this.normalizeUnitTypes(unitTypes);
    this.recomputeTotals(project.inventory);

    await project.save();
    return project;
  }

  /**
   * Sell one unit of the given type (called on deal closed_won).
   * available -> sold. Clamps at 0 (never negative).
   *
   * @param {string} projectId
   * @param {string} unitTypeLabel  e.g. "2BHK" (may be null)
   * @returns {Object} { applied, reason, unitType, project }
   */
  async sellUnit(projectId, unitTypeLabel, quantity = 1) {
    const qty = Math.max(1, Number(quantity) || 1);
    const project = await Project.findById(projectId);
    if (!project) {
      return { applied: false, reason: 'project_not_found', project: null };
    }

    // No inventory configured — nothing to decrement, but don't error.
    if (!project.inventory || !(project.inventory.unitTypes || []).length) {
      return { applied: false, reason: 'no_inventory_configured', project };
    }

    const unitType = this._resolveUnitType(project, unitTypeLabel);

    if (!unitType) {
      // Couldn't determine which specific type sold. Record at project level
      // only (soldUnits up) without guessing a specific unit type, and flag it.
      return {
        applied: false,
        reason: 'unit_type_unresolved',
        needsBuilderConfirmation: true,
        project
      };
    }

    const sellable = Math.min(qty, unitType.availableUnits || 0);
    if (sellable <= 0) {
      return { applied: false, reason: 'no_available_units', unitType: unitType.label, project };
    }

    unitType.availableUnits = Math.max(0, (unitType.availableUnits || 0) - sellable);
    unitType.soldUnits = (unitType.soldUnits || 0) + sellable;

    this.recomputeTotals(project.inventory);
    await project.save();

    // Keep plot-map polygons in sync for plot projects.
    await this._syncLayoutEntityStatus(project, unitType.label, 'sold', sellable);

    return { applied: true, reason: 'sold', unitType: unitType.label, quantity: sellable, project };
  }

  /**
   * STUB (future booking lifecycle): available -> booked.
   * Wired-ready so a negotiation/site-visit trigger can call it later
   * without changing call sites.
   */
  async bookUnit(projectId, unitTypeLabel, quantity = 1) {
    // Intentionally not active in start-simple scope.
    return { applied: false, reason: 'booking_not_enabled' };
  }

  /**
   * STUB (future): release a booked unit back to available (closed_lost).
   */
  async releaseUnit(projectId, unitTypeLabel, quantity = 1) {
    return { applied: false, reason: 'release_not_enabled' };
  }

  /**
   * For plot projects, flip matching layoutEntities subplot status.
   * Best-effort — never throws into the caller.
   */
  async _syncLayoutEntityStatus(project, unitTypeLabel, status, count) {
    try {
      const entities = project.layoutEntities || [];
      if (!entities.length) return;

      let remaining = count;
      let changed = false;
      for (const ent of entities) {
        if (remaining <= 0) break;
        if (ent.type === 'subplot' && ent.status === 'available' && !ent.deleted) {
          ent.status = status;
          remaining -= 1;
          changed = true;
        }
      }
      if (changed) await project.save();
    } catch (err) {
      console.error('InventoryService._syncLayoutEntityStatus error:', err.message);
    }
  }

  /**
   * Seed an inventory skeleton from the project's configuration.bhkOptions.
   * Returns unitTypes[] with zeroed counts a builder can then fill in.
   */
  seedFromConfiguration(project) {
    const bhkOptions = project.configuration?.bhkOptions || [];
    return bhkOptions.map((label) => ({
      label,
      totalUnits: 0,
      availableUnits: 0,
      bookedUnits: 0,
      soldUnits: 0,
      pricePerUnit: 0
    }));
  }
}

module.exports = new InventoryService();
