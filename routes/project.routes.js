const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/ProjectController");
const { protect, restrictTo } = require("../middleware/auth");

// --- PUBLIC ROUTES (No Auth Required) ---

// --- PUBLIC ROUTES ---
// Only the builder portfolio page is genuinely public: /portfolio/[builderId]
// renders it for anonymous visitors. It returns the builder's public identity
// (name, company) and their published projects — nothing private.
router.get("/public/owners/:ownerId/projects", (req, res) => ProjectController.getProjectsByOwnerId(req, res));


// --- PROTECTED ROUTES (Auth Required) ---
router.use(protect);

// Phone → user lookups. These were previously declared ABOVE `protect`, making
// them fully public: /verify-user/:phone returned the name and role of ANY
// registered user given their phone number. Since phone is the login identifier,
// that was an account-enumeration oracle. Neither endpoint is called by any
// client (both were dead wrappers in HIT_Frontend/src/lib/api.ts), so requiring
// auth costs nothing. Same treatment already applied to /api/users/by-role/:role.
router.get("/verify-user/:phone", restrictTo('admin'), (req, res) => ProjectController.verifyUserByPhone(req, res));
router.get("/by-owner-phone/:phone", restrictTo('admin', 'captain'), (req, res) => ProjectController.getProjectsByOwnerPhone(req, res));

// Get all captains (admin only) - must be before /:projectId routes
router.get("/captains", restrictTo('admin'), (req, res) => ProjectController.getCaptains(req, res));

// Get agents under the logged-in captain (captain only) - must be before /:projectId routes
router.get("/my-agents", restrictTo('captain'), (req, res) => ProjectController.getMyAgents(req, res));

// Assign captain to project (admin only)
router.put("/:projectId/assign-captain", restrictTo('admin'), (req, res) => ProjectController.assignCaptain(req, res));

// Add/remove a co-captain (second captain) on a project (admin only)
router.put("/:projectId/assign-co-captain", restrictTo('admin'), (req, res) => ProjectController.assignCoCaptain(req, res));

// Assign agent to project (captain only)
router.put("/:projectId/assign-agent", restrictTo('captain'), (req, res) => ProjectController.assignAgent(req, res));

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

// Save layout entities (map polygons, plots, roads, boundaries)
router.put("/:projectId/layout-entities", (req, res) => ProjectController.saveLayoutEntities(req, res));

module.exports = router;
