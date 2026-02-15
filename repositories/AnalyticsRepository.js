const Visit = require('../models/Visit');
const CtaClick = require('../models/CtaClick');

class AnalyticsRepository {
  // Visits
  async addVisit(visitData) {
    const visit = new Visit(visitData);
    await visit.save();
    return visit.toObject();
  }
  
  async getVisitsByProject(projectId) {
    return Visit.find({ projectId }).lean();
  }

  async updateVisitDuration(visitId, duration, projectId) {
    const query = projectId 
      ? { visitId, projectId }
      : { visitId };
    
    const visit = await Visit.findOne(query);
    if (visit) {
      visit.duration = (visit.duration || 0) + duration;
      await visit.save();
      return true;
    }
    return false;
  }

  // CTA Clicks
  async addCtaClick(clickData) {
    const click = new CtaClick(clickData);
    await click.save();
    return click.toObject();
  }

  async getCtaClicksByProject(projectId) {
    return CtaClick.find({ projectId }).lean();
  }

  async getAllVisits() {
    return Visit.find().lean();
  }

  async getAllCtaClicks() {
    return CtaClick.find().lean();
  }
}

module.exports = new AnalyticsRepository();
