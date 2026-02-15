const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { mockAuthMiddleware, requireRole } = require("../middleware/mockAuth");

// Apply mock auth
router.use(mockAuthMiddleware);

/**
 * GET /api/users/me
 * Get current user info (based on x-mock-user-id header)
 */
router.get("/me", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        res.json(req.user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/users
 * Admin only: List all users
 */
router.get("/", requireRole("admin"), async (req, res) => {
    try {
        const { role } = req.query;
        const filter = role ? { role } : {};

        const users = await User.find(filter)
            .select("-__v")
            .lean();

        const mapped = users.map(u => ({
            id: u._id.toString(),
            name: u.name,
            email: u.email,
            role: u.role,
            companyName: u.companyName,
            phone: u.phone,
            isActive: u.isActive
        }));

        res.json(mapped);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/users/mock-accounts
 * Public: Get list of available mock accounts for role switcher
 */
router.get("/mock-accounts", async (req, res) => {
    try {
        const users = await User.find({ isActive: true })
            .select("_id name email role")
            .lean();

        const mapped = users.map(u => ({
            id: u._id.toString(),
            name: u.name,
            email: u.email,
            role: u.role
        }));

        res.json(mapped);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/users/login-by-name
 * Public: Find user by name and role (case-insensitive)
 * Used for mock login flow
 */
router.post("/login-by-name", async (req, res) => {
    try {
        const { name, role, phone } = req.body;

        if (!name || !role || !phone) {
            return res.status(400).json({ error: "Name, role, and phone are required" });
        }

        // Case-insensitive search for name
        const user = await User.findOne({
            name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
            phone: phone.trim(),
            role: role,
            isActive: true
        }).lean();

        if (!user) {
            return res.status(404).json({
                error: "Authentication failed",
                hint: `No active user found matching name "${name}", role "${role}", and phone "${phone}".`
            });
        }

        res.json({
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            role: user.role
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/users/by-role/:role
 * Public: Get list of users by role (for login dropdown)
 */
router.get("/by-role/:role", async (req, res) => {
    try {
        const { role } = req.params;

        if (!['admin', 'builder', 'agent'].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        const users = await User.find({ role, isActive: true })
            .select("_id name email")
            .lean();

        const mapped = users.map(u => ({
            id: u._id.toString(),
            name: u.name,
            email: u.email
        }));

        res.json(mapped);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
