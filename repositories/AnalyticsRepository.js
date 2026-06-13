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

  async getProjectVisitStats(projectId, startDate, endDate) {
    const ProjectVisit = require('../models/ProjectVisit');
    const now = new Date();
    const start = startDate ? new Date(startDate) : new Date(now - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : now;

    const result = await ProjectVisit.aggregate([
      { $match: { projectId: String(projectId), startTime: { $gte: start, $lte: end } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalVisits: { $sum: 1 },
                avgDuration: { $avg: '$duration' },
                uniqueVisitorSet: { $addToSet: '$leadId' }
              }
            }
          ],
          ctaBreakdown: [
            { $unwind: { path: '$ctaClicks', preserveNullAndEmptyArrays: false } },
            { $group: { _id: '$ctaClicks.type', count: { $sum: 1 } } }
          ],
          topSources: [
            { $group: { _id: '$source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
          ],
          visitsByDay: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$startTime' } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ]
        }
      }
    ]);

    const facet = result[0] || {};
    const totals = facet.totals?.[0] || {};
    return {
      totalVisits: totals.totalVisits || 0,
      uniqueVisitors: (totals.uniqueVisitorSet || []).filter(Boolean).length,
      avgDurationSeconds: Math.round(totals.avgDuration || 0),
      ctaBreakdown: (facet.ctaBreakdown || []).map(c => ({ type: c._id, count: c.count })),
      topLeadSources: (facet.topSources || []).map(s => ({ source: s._id, count: s.count })),
      visitsByDay: (facet.visitsByDay || []).map(d => ({ date: d._id, count: d.count }))
    };
  }

  async getOwnerVisitStats(ownerId, startDate, endDate) {
    const ProjectVisit = require('../models/ProjectVisit');
    const now = new Date();
    const start = startDate ? new Date(startDate) : new Date(now - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : now;

    const result = await ProjectVisit.aggregate([
      { $match: { ownerId: String(ownerId), startTime: { $gte: start, $lte: end } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalVisits: { $sum: 1 },
                avgDuration: { $avg: '$duration' },
                uniqueVisitorSet: { $addToSet: '$leadId' }
              }
            }
          ],
          ctaBreakdown: [
            { $unwind: { path: '$ctaClicks', preserveNullAndEmptyArrays: false } },
            { $group: { _id: '$ctaClicks.type', count: { $sum: 1 } } }
          ],
          topSources: [
            { $group: { _id: '$source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
          ],
          visitsByDay: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$startTime' } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ]
        }
      }
    ]);

    const facet = result[0] || {};
    const totals = facet.totals?.[0] || {};
    return {
      totalVisits: totals.totalVisits || 0,
      uniqueVisitors: (totals.uniqueVisitorSet || []).filter(Boolean).length,
      avgDurationSeconds: Math.round(totals.avgDuration || 0),
      ctaBreakdown: (facet.ctaBreakdown || []).map(c => ({ type: c._id, count: c.count })),
      topLeadSources: (facet.topSources || []).map(s => ({ source: s._id, count: s.count })),
      visitsByDay: (facet.visitsByDay || []).map(d => ({ date: d._id, count: d.count }))
    };
  }
}

module.exports = new AnalyticsRepository();
