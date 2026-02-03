const AnalyticsRepository = require('../repositories/AnalyticsRepository');
const ProjectService = require('./ProjectService');

class AnalyticsService {
  async trackPageView(data) {
    const visit = {
      ...data,
      timestamp: new Date()
    };
    return await AnalyticsRepository.addVisit(visit);
  }

  async trackTime(data) {
    const { visitId, duration, projectId } = data;
    if (visitId && duration) {
      return await AnalyticsRepository.updateVisitDuration(visitId, duration, projectId);
    }
    return false;
  }

  async trackCtaClick(data) {
    const click = {
      ...data,
      timestamp: new Date()
    };
    return await AnalyticsRepository.addCtaClick(click);
  }

  async getProjectStats(projectId) {
    const visits = await AnalyticsRepository.getVisitsByProject(projectId);
    const ctaClicks = await AnalyticsRepository.getCtaClicksByProject(projectId);

    const totalTimeSpent = visits.reduce((acc, v) => acc + (v.duration || 0), 0);

    return {
      totalVisits: visits.length,
      uniqueLeads: new Set(visits.map(v => v.leadId)).size,
      totalTimeSpent: totalTimeSpent,
      ctaClicks: ctaClicks,
      recentVisits: visits.slice(-10).reverse()
    };
  }

  async getSystemOverview() {
    const projects = await ProjectService.getAllProjects();
    
    const results = [];
    for (const project of projects) {
      const projectId = project._id?.toString() || project.id;
      const visits = await AnalyticsRepository.getVisitsByProject(projectId);
      const ctaClicks = await AnalyticsRepository.getCtaClicksByProject(projectId);
      
      results.push({
        id: projectId,
        name: project.projectName || project.name,
        totalVisits: visits.length,
        uniqueLeads: new Set(visits.map(v => v.leadId)).size,
        totalTimeSpent: visits.reduce((acc, v) => acc + (v.duration || 0), 0),
        ctaClicks: ctaClicks.length,
        calls: ctaClicks.filter(c => c.ctaType === 'call').length,
        whatsapp: ctaClicks.filter(c => c.ctaType === 'whatsapp').length,
        forms: ctaClicks.filter(c => c.ctaType === 'form').length 
      });
    }
    
    return results;
  }
}

module.exports = new AnalyticsService();
