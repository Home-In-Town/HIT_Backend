const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { protect, restrictTo } = require("../middleware/auth");

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

        if (!['admin', 'builder', 'agent', 'unassigned', 'user'].includes(role)) {
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

/**
 * PATCH /api/users/profile
 * Update current user's profile (name, email, companyName).
 * Phone changes are NOT allowed here — require OTP flow.
 */
router.patch('/profile', protect, async (req, res) => {
    try {
        const { name, email, companyName, businessLogoUrl } = req.body;
        const userId = req.user._id;

        // Explicitly reject phone changes
        if (req.body.phone !== undefined) {
            return res.status(400).json({ error: 'Phone changes require OTP verification. Use the forgot MPIN flow.' });
        }

        // Build update object — only include provided fields
        const updates = {};
        if (name !== undefined) {
            const trimmed = name.trim();
            if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
            updates.name = trimmed;
        }
        if (email !== undefined) {
            const trimmedEmail = email.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
                return res.status(400).json({ error: 'Invalid email format' });
            }
            // Check for duplicate email on a DIFFERENT user
            const existing = await User.findOne({ email: trimmedEmail, _id: { $ne: userId } });
            if (existing) {
                return res.status(409).json({ error: 'Email is already registered to another account' });
            }
            updates.email = trimmedEmail;
        }
        if (companyName !== undefined) {
            updates.companyName = companyName.trim();
        }
        if (businessLogoUrl !== undefined) {
            updates.businessLogoUrl = businessLogoUrl.trim() || null;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields provided to update' });
        }

        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { $set: updates },
            { new: true, runValidators: true }
        ).select('-mpin');

        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user: updatedUser });
    } catch (error) {
        console.error('PATCH /profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/users/crm-redirect-base
 * Returns the LeadGen backend URL for constructing SSO redirect URLs in the frontend.
 * Authenticated — only available to admin/builder/agent.
 */
router.get('/crm-redirect-base', protect, (req, res) => {
    const allowedRoles = ['admin', 'builder', 'agent'];
    if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const url = process.env.LEADGEN_BACKEND_URL || '';
    res.json({ redirectBase: url });
});

module.exports = router;
