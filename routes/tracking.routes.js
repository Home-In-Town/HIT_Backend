const express = require("express");
const router = express.Router();
const AnalyticsController = require("../controllers/AnalyticsController");

router.post("/pageview", (req, res) => AnalyticsController.trackPageView(req, res));
router.post("/time", (req, res) => AnalyticsController.trackTime(req, res));
router.post("/cta", (req, res) => AnalyticsController.trackCta(req, res));

module.exports = router;
