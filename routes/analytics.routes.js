const express = require("express");
const router = express.Router();
const AnalyticsController = require("../controllers/AnalyticsController");
const { protect } = require('../middleware/auth');

router.get(
  "/overview",
  protect,
  (req, res) => AnalyticsController.getOverview(req, res)
);

router.get(
  "/global-overview",
  protect,
  (req, res) => AnalyticsController.getGlobalOverview(req, res)
);
router.get("/projects/:projectId", (req, res) => AnalyticsController.getProjectStats(req, res));

// Public — property analytics (no auth)
router.get('/property/:projectId', (req, res) => AnalyticsController.getPropertyAnalytics(req, res));

// Authenticated — owner analytics
router.get('/owner', protect, (req, res) => AnalyticsController.getOwnerAnalytics(req, res));

module.exports = router;
