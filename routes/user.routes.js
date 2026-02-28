const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { protect, restrictTo } = require("../middleware/auth");
const jwt = require('jsonwebtoken');

/**
 * GET /api/users/sso/token
 * Generates a short-lived SSO token for the current user
 */
router.get("/sso/token", protect, async (req, res) => {
    try {
        const user = req.user; // Already fetched by protect

        const payload = {
            id: user._id.toString(),
            name: user.name,
            role: user.role,
            phone: user.phone,
            companyName: user.companyName
        };

        const secret = process.env.INTERNAL_API_SECRET || 'hit-internal-secret-2024';
        const token = jwt.sign(payload, secret, { expiresIn: '2m' });

        res.json({ token });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/users/me
 * Get current user info
 */
router.get("/me", protect, async (req, res) => {
    try {
        res.json(req.user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/users
 * Admin only: List all users
 */
router.get("/", protect, restrictTo('admin'), async (req, res) => {
    try {
        const { role } = req.query;
        const filter = role ? { role } : {};

        const users = await User.find(filter)
            .select("-__v -mpin")
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
 * Public: Get list of users by role (for login dropdown - DEPRECATED in new auth but kept for compat)
 */
router.get("/by-role/:role", async (req, res) => {
    try {
        const { role } = req.params;

        if (!['admin', 'builder', 'agent'].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        const users = await User.find({ role, isActive: true })
            .select("_id name email phone")
            .lean();

        const mapped = users.map(u => ({
            id: u._id.toString(),
            name: u.name,
            email: u.email,
            phone: u.phone
        }));

        res.json(mapped);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/users/:id/role
 * Admin only: Assign/Update user role
 */
router.put("/:id/role", async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        if (!['admin', 'builder', 'agent', 'unassigned'].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        const user = await User.findByIdAndUpdate(
            id,
            { role },
            { new: true }
        ).select("-mpin -__v");

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
