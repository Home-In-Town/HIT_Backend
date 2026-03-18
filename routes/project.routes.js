const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/ProjectController");
const { protect } = require("../middleware/auth");

// --- PUBLIC ROUTES (No Auth Required) ---

// Verify User by Phone
router.get("/verify-user/:phone", (req, res) => ProjectController.verifyUserByPhone(req, res));

// Get projects by owner phone
router.get("/by-owner-phone/:phone", (req, res) => ProjectController.getProjectsByOwnerPhone(req, res));

// Get projects by owner ID (Public Portfolio)
router.get("/public/owners/:ownerId/projects", (req, res) => ProjectController.getProjectsByOwnerId(req, res));


// --- PROTECTED ROUTES (Auth Required) ---
router.use(protect);

// List all projects (filtered by role)
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

// Save landmarks
router.put("/:projectId/landmarks", (req, res) => ProjectController.saveLandmarks(req, res));

module.exports = router;

