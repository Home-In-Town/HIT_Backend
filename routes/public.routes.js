const express = require("express");
const ProjectController = require("../controllers/ProjectController");

const router = express.Router();

/**
 * Get Public Project Page
 */
<<<<<<< HEAD
=======
router.get("/projects", (req, res) => ProjectController.getAllPublic(req, res));
>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
router.get("/projects/:slug", (req, res) => ProjectController.getOneBySlug(req, res));

module.exports = router;
