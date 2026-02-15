const express = require("express");
const router = express.Router();
const AnalyticsController = require("../controllers/AnalyticsController");

router.post("/pageview", (req, res) => AnalyticsController.trackPageView(req, res));
router.post("/time", (req, res) => AnalyticsController.trackTime(req, res));
router.post("/cta", (req, res) => AnalyticsController.trackCta(req, res));
<<<<<<< HEAD
=======
router.post("/form", (req, res) => AnalyticsController.trackFormSubmit(req, res));
>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae

module.exports = router;
