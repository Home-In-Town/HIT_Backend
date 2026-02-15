const express = require("express");
const ProjectController = require("../controllers/ProjectController");

const router = express.Router();

/**
 * Get Public Project Page
 */
router.get("/projects/:slug", (req, res) => ProjectController.getOneBySlug(req, res));

module.exports = router;
