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
      const stats = await AnalyticsService.getSystemOverview();
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
}

module.exports = new AnalyticsController();
