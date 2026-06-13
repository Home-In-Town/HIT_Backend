const AnalyticsService = require('../services/AnalyticsService');

class AnalyticsController {
  async trackPageView(req, res) {
    try {
      await AnalyticsService.trackPageView(req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async trackTime(req, res) {
    try {
      await AnalyticsService.trackTime(req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async trackCta(req, res) {
    try {
      await AnalyticsService.trackCtaClick(req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getProjectStats(req, res) {
    try {
      const stats = await AnalyticsService.getProjectStats(req.params.projectId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getOverview(req, res) {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const stats = await AnalyticsService.getOverviewByUser(req.user);
      res.json(stats);

    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getGlobalOverview(req, res) {
    try {
      if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ message: "Forbidden: Admin access required" });
      }

      const stats = await AnalyticsService.getGlobalStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async trackFormSubmit(req, res) {
    try {
      await AnalyticsService.trackFormSubmit(req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getPropertyAnalytics(req, res) {
    try {
      const { projectId } = req.params;
      const { startDate, endDate } = req.query;
      const result = await AnalyticsService.getPropertyAnalytics(projectId, startDate, endDate);
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getOwnerAnalytics(req, res) {
    try {
      const { startDate, endDate } = req.query;
      const result = await AnalyticsService.getOwnerAnalytics(req.user, startDate, endDate);
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new AnalyticsController();
