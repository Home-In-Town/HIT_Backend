const AnalyticsRepository = require('../repositories/AnalyticsRepository');
const ProjectService = require('./ProjectService');
const WebhookService = require('./WebhookService');

class AnalyticsService {
  async trackPageView(data) {
    const visit = {
      ...data,
      timestamp: new Date()
    };
    const result = await AnalyticsRepository.addVisit(visit);

    // Send webhook event (non-blocking)
    if (data.leadId) {
      WebhookService.sendPageViewEvent({
        leadId: data.leadId,
        projectId: data.projectId,
        projectSlug: data.projectSlug,
        visitId: result?.id || result?._id?.toString(),
        userAgent: data.userAgent,
        referrer: data.referrer
      }).catch(err => console.error('Webhook error:', err.message));
    }

    return result;
  }

  async trackTime(data) {
    const { visitId, duration, projectId, leadId } = data;
    if (visitId && duration) {
      const result = await AnalyticsRepository.updateVisitDuration(visitId, duration, projectId);

      // Send webhook event (non-blocking)
      if (leadId) {
        WebhookService.sendTimeUpdateEvent({
          leadId,
          projectId,
          visitId,
          duration
        }).catch(err => console.error('Webhook error:', err.message));
      }

      return result;
    }
    return false;
  }

  async trackCtaClick(data) {
    const click = {
      ...data,
      timestamp: new Date()
    };
    const result = await AnalyticsRepository.addCtaClick(click);

    // Send webhook event (non-blocking)
    if (data.leadId) {
      WebhookService.sendCtaClickEvent({
        leadId: data.leadId,
        projectId: data.projectId,
        ctaType: data.ctaType,
        clickId: result?.id || result?._id?.toString()
      }).catch(err => console.error('Webhook error:', err.message));
    }

    return result;
  }

  async trackFormSubmit(data) {
    // Send webhook event for form submission
    if (data.leadId) {
      await WebhookService.sendFormSubmitEvent({
        leadId: data.leadId,
        projectId: data.projectId,
        formData: data.formData
      }).catch(err => console.error('Webhook error:', err.message));
    }

    return { success: true };
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

 async getOverviewByUser(user) {
  if (!user) {
    throw new Error("User required");
  }

  let projects = [];

  // =============================
  // ADMIN → All Projects
  // =============================
  if (user.role === "admin") {
    projects = await ProjectService.getAllProjects();
  }

  // =============================
  // BUILDER → Created Projects
  // =============================
  else if (user.role === "builder") {
    projects = await ProjectService.getProjectsByBuilder(user.id);
  }

  // =============================
  // AGENT → Created + Assigned
  // =============================
  else if (user.role === "agent") {

    // 1️⃣ Projects created by agent
    const createdProjects = await ProjectService.getProjectsByBuilder(user.id);

    // 2️⃣ Projects assigned via organization
    const assignedProjects = await ProjectService.getProjectsForAgent(user.id);

    // 3️⃣ Merge and remove duplicates safely
    const projectMap = new Map();

    [...createdProjects, ...assignedProjects].forEach(project => {
      const id = project._id?.toString() || project.id;
      if (id) {
        projectMap.set(id, project);
      }
    });

    projects = Array.from(projectMap.values());
  }

  // =============================
  // Generate Analytics
  // =============================
  const results = [];

  for (const project of projects) {
    const projectId = project._id?.toString() || project.id;
    if (!projectId) continue;

    const visits = await AnalyticsRepository.getVisitsByProject(projectId);
    const ctaClicks = await AnalyticsRepository.getCtaClicksByProject(projectId);

    results.push({
      id: projectId,
      name: project.projectName || project.name,
      totalVisits: visits.length,
      uniqueLeads: new Set(
        visits.map(v => v.leadId).filter(Boolean)
      ).size,
      totalTimeSpent: visits.reduce(
        (acc, v) => acc + (v.duration || 0),
        0
      ),
      ctaClicks: ctaClicks.length,
      calls: ctaClicks.filter(c => c.ctaType === "call").length,
      whatsapp: ctaClicks.filter(c => c.ctaType === "whatsapp").length,
      forms: ctaClicks.filter(c => c.ctaType === "form").length
    });
  }

  return results;
}


}



module.exports = new AnalyticsService();
