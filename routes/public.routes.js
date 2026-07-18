const express = require("express");
const ProjectController = require("../controllers/ProjectController");
const ShareController = require("../controllers/shareController");

const router = express.Router();

/**
 * Get Public Project Page
 */
router.get("/projects", (req, res) => ProjectController.getAllPublic(req, res));
router.get("/projects/:slug", (req, res) => ProjectController.getOneBySlug(req, res));
router.get("/owners/:ownerId/projects", (req, res) => ProjectController.getProjectsByOwnerId(req, res));

/**
 * Resolve a share token — returns project + sharer's contact details (no auth needed)
 */
router.get("/share/:token", (req, res) => ShareController.resolveToken(req, res));

module.exports = router;
