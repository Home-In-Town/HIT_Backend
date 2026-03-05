const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const msg91Service = require('../services/msg91.service');

// Constants
// Constants - Updated for cross-domain support (localhost -> Cloud Run)
const getCookieOptions = (req) => {
    const isProd = process.env.NODE_ENV === 'production';
    const origin = req.get('origin');
    const isCrossDomain = origin && !origin.includes(req.get('host'));

    return {
        httpOnly: true,
        // Must be secure and SameSite=none for cross-domain cookies to work (e.g. localhost -> Cloud Run)
        secure: isProd || isCrossDomain,
        sameSite: (isProd || isCrossDomain) ? 'none' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    };
};

/**
 * Check if the user exists for the given phone number.
 */
exports.checkPhone = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone number is required' });

        const user = await User.findOne({ phone, isVerified: true });

        if (user) {
            return res.json({ exists: true, name: user.name });
        } else {
            return res.json({ exists: false });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Initial Registration - Creates a pending user and sends OTP.
 */
exports.register = async (req, res) => {
    try {
        const { name, phone, mpin, email } = req.body;

        if (!name || !phone || !mpin) {
            return res.status(400).json({ error: 'Name, Phone, and MPIN are required' });
        }

        // Check if user already exists
        let user = await User.findOne({ phone });

        // If user exists and is already verified, trigger login logic elsewhere
        if (user && user.isVerified) {
            return res.status(400).json({ error: 'User already exists. Please login.' });
        }

        // Hash the MPIN
        const hashedMpin = await bcrypt.hash(mpin.toString(), 12);

        if (!user) {
            // Create new pending user
            user = new User({
                name,
                phone,
                mpin: hashedMpin,
                email: email || '',
                isVerified: false,
                role: 'unassigned'
            });
        } else {
            // Update the unverified user with new details
            user.name = name;
            user.mpin = hashedMpin;
            user.email = email || '';
        }

        await user.save();

        // Send MSG91 Verification
        await msg91Service.sendVerification(phone);

        res.json({ message: 'Verification OTP sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Verify Registration/Reset OTP and log the user in.
 */
exports.verifyOtp = async (req, res) => {
    try {
        const { phone, code, type } = req.body; // type could be 'register' or 'reset'

        if (!phone || !code) {
            return res.status(400).json({ error: 'Phone and Code are required' });
        }

        // Verify with MSG91
        const isApproved = await msg91Service.checkVerification(phone, code);
        if (!isApproved) {
            return res.status(401).json({ error: 'Invalid or expired OTP' });
        }

        // Fetch user
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Update user
        user.isVerified = true;
        await user.save();

        // Generate Token
        const token = jwt.sign(
            { id: user._id, name: user.name, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Set Cookie
        res.cookie('token', token, getCookieOptions(req));

        res.json({
            message: 'Verification successful',
            user: {
                id: user._id,
                name: user.name,
                role: user.role
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Sign-In using Phone + MPIN only.
 */
exports.login = async (req, res) => {
    try {
        const { phone, mpin } = req.body;

        if (!phone || !mpin) {
            return res.status(400).json({ error: 'Phone and MPIN are required' });
        }

        const user = await User.findOne({ phone, isVerified: true });
        if (!user) {
            return res.status(404).json({ error: 'User not found or not verified' });
        }

        // Check MPIN
        const isMatch = await bcrypt.compare(mpin.toString(), user.mpin);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid MPIN' });
        }

        // Check if user is active
        if (!user.isActive) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Generate Token
        const token = jwt.sign(
            { id: user._id, name: user.name, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Set Cookie
        res.cookie('token', token, getCookieOptions(req));

        res.json({
            message: 'Login successful',
            user: {
                id: user._id,
                name: user.name,
                role: user.role
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Forgot MPIN - Send Verification OTP.
 */
exports.forgotMpin = async (req, res) => {
    try {
        const { phone } = req.body;
        const user = await User.findOne({ phone, isVerified: true });
        if (!user) return res.status(404).json({ error: 'User not found' });

        await msg91Service.sendVerification(phone);
        res.json({ message: 'Verification OTP sent for MPIN reset' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Reset MPIN - After OTP Verification.
 */
exports.resetMpin = async (req, res) => {
    try {
        const { phone, code, newMpin } = req.body;

        if (!phone || !code || !newMpin) {
            return res.status(400).json({ error: 'Phone, Code, and New MPIN are required' });
        }

        // Verify code
        const isApproved = await msg91Service.checkVerification(phone, code);
        if (!isApproved) {
            return res.status(401).json({ error: 'Invalid or expired OTP' });
        }

        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Update MPIN
        user.mpin = await bcrypt.hash(newMpin.toString(), 12);
        await user.save();

        res.json({ message: 'MPIN reset successful. Please login.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Get current user info (for session persistence).
 */
exports.getMe = async (req, res) => {
    try {
        // req.user is set by the protect middleware
        res.json(req.user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Logout - Clear Cookie.
 */
exports.logout = (req, res) => {
    res.clearCookie('token', getCookieOptions(req));
    res.json({ message: 'Logged out successfully' });
};
