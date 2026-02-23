const express = require("express");
const ProjectController = require("../controllers/ProjectController");

const router = express.Router();

/**
 * Get Public Project Page
 */
router.get("/projects", (req, res) => ProjectController.getAllPublic(req, res));
router.get("/projects/:slug", (req, res) => ProjectController.getOneBySlug(req, res));
router.get("/owners/:ownerId/projects", (req, res) => ProjectController.getProjectsByOwnerId(req, res));

module.exports = router;
