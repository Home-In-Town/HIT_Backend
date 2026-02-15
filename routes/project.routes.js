const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/ProjectController");

// List all projects
router.get("/", (req, res) => ProjectController.getAll(req, res));

// Create a new project
router.post("/", (req, res) => ProjectController.create(req, res));

// Get specific project
router.get("/:projectId", (req, res) => ProjectController.getOne(req, res));

// Update project
router.put("/:projectId", (req, res) => ProjectController.update(req, res));

// Delete project
router.delete("/:projectId", (req, res) => ProjectController.delete(req, res));

// Publish project
router.post("/:projectId/publish", (req, res) => ProjectController.publish(req, res));

module.exports = router;
