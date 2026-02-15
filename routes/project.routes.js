const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/ProjectController");
<<<<<<< HEAD

// List all projects
=======
const { mockAuthMiddleware } = require("../middleware/mockAuth");

// Apply mock auth to all project routes
router.use(mockAuthMiddleware);

// List all projects (filtered by role)
>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
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

<<<<<<< HEAD
module.exports = router;
=======
// Get projects by builder phone (Public/New endpoint)
router.get("/by-builder-phone/:phone", (req, res) => ProjectController.getProjectsByBuilderPhone(req, res));

// Get projects by builder ID (Public Portfolio)
router.get("/public/builders/:builderId/projects", (req, res) => ProjectController.getProjectsByBuilderId(req, res));

// Verify User by Phone (Public/New endpoint)
router.get("/verify-user/:phone", (req, res) => ProjectController.verifyUserByPhone(req, res));

module.exports = router;

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
