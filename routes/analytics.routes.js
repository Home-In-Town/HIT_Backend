const express = require("express");
const router = express.Router();
const AnalyticsController = require("../controllers/AnalyticsController");
const { protect } = require('../middleware/auth');

router.get(
  "/overview",
  protect,
  (req, res) => AnalyticsController.getOverview(req, res)
);
router.get("/projects/:projectId", (req, res) => AnalyticsController.getProjectStats(req, res));

module.exports = router;
