const express = require("express");
const router = express.Router();
const AnalyticsController = require("../controllers/AnalyticsController");
const { mockAuthMiddleware } = require('../middleware/mockAuth');

router.get(
  "/overview",
  mockAuthMiddleware,   
  (req, res) => AnalyticsController.getOverview(req, res)
);
router.get("/projects/:projectId", (req, res) => AnalyticsController.getProjectStats(req, res));

module.exports = router;
