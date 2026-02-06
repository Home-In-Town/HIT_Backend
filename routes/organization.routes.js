const express = require("express");
const router = express.Router();
const Organization = require("../models/Organization");
const { mockAuthMiddleware, requireRole } = require("../middleware/mockAuth");

// Apply mock auth to all organization routes
router.use(mockAuthMiddleware);

/**
 * GET /api/organizations
 * Admin: Get all organizations
 * Agent: Get organizations they belong to
 */
router.get("/", async (req, res) => {
    try {
        const user = req.user;
        let orgs;

        if (!user) {
            return res.status(401).json({ error: "Authentication required" });
        }

        if (user.role === "admin") {
            // Admin sees all organizations
            orgs = await Organization.find()
                .populate("agents", "name email role")
                .populate("projects", "projectName status")
                .lean();
        } else if (user.role === "agent") {
            // Agent sees only their organizations
            orgs = await Organization.find({ agents: user.id })
                .populate("agents", "name email role")
                .populate("projects", "projectName status")
                .lean();
        } else {
            // Builders don't see organizations
            orgs = [];
        }

        // Map _id to id
        const mapped = orgs.map(org => ({
            id: org._id.toString(),
            name: org.name,
            description: org.description,
            agents: org.agents,
            projects: org.projects,
            createdAt: org.createdAt
        }));

        res.json(mapped);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/organizations
 * Admin only: Create a new organization
 */
router.post("/", requireRole("admin"), async (req, res) => {
    try {
        const { name, description, agents = [], projects = [] } = req.body;

        const org = new Organization({
            name,
            description,
            createdBy: req.user.id,
            agents,
            projects
        });

        await org.save();

        res.status(201).json({
            id: org._id.toString(),
            name: org.name,
            description: org.description,
            agents: org.agents,
            projects: org.projects
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/organizations/:id
 * Admin only: Update organization (add/remove agents, projects)
 */
router.put("/:id", requireRole("admin"), async (req, res) => {
    try {
        const { name, description, agents, projects } = req.body;
        const updates = {};

        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (agents !== undefined) updates.agents = agents;
        if (projects !== undefined) updates.projects = projects;

        const org = await Organization.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        )
            .populate("agents", "name email role")
            .populate("projects", "projectName status")
            .lean();

        if (!org) {
            return res.status(404).json({ error: "Organization not found" });
        }

        res.json({
            id: org._id.toString(),
            name: org.name,
            description: org.description,
            agents: org.agents,
            projects: org.projects
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/organizations/:id
 * Admin only: Delete organization
 */
router.delete("/:id", requireRole("admin"), async (req, res) => {
    try {
        const result = await Organization.findByIdAndDelete(req.params.id);
        if (!result) {
            return res.status(404).json({ error: "Organization not found" });
        }
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
