const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const msg91Service = require('../services/msg91.service');
const Logger = require('../utils/logger');
const { catchAsync, AppError } = require('../middleware/errorHandler');

const logger = new Logger('AuthController');

/**
 * Silently attempts to auto-link the HIT user to a matching LeadGen Owner.
 * Runs in the background — never blocks the login response.
 * Only runs for admin/builder/agent roles.
 * Skips if already linked.
 */
async function tryAutoLinkLeadGen(user) {
    try {
        // Only link CRM-relevant roles
        if (!['admin', 'builder', 'agent'].includes(user.role)) return;
        // Already linked — nothing to do
        if (user.oneEmployeeLinked && user.oneEmployeeOwnerId) return;
        // Need at least phone or email
        if (!user.phone && !user.email) return;

        const leadGenService = require('../services/LeadGenService');
        const result = await leadGenService.lookupOwner(user.phone, user.email);

        if (!result.found || !result.owner) return;

        const owner = result.owner;
        const hitUserId = user._id.toString();
        const ownerId = owner._id.toString();

        // Don't auto-link if the Owner is already linked to a DIFFERENT HIT user
        if (owner.salesProfileId && owner.salesProfileId !== hitUserId) {
            logger.info('Auto-link skipped: Owner already linked to another user', {
                userId: hitUserId, ownerId
            });
            return;
        }

        // Perform the link
        await leadGenService.linkOwner(ownerId, hitUserId);
        await User.findByIdAndUpdate(user._id, {
            $set: { oneEmployeeLinked: true, oneEmployeeOwnerId: ownerId }
        });
        logger.info('Auto-linked HIT user to LeadGen Owner', { userId: hitUserId, ownerId });
    } catch (err) {
        // Never throw — auto-link is best-effort
        logger.warn('Auto-link attempt failed (non-critical)', { error: err.message });
    }
}

// Constants - Updated for cross-domain support (localhost -> Cloud Run)
const getCookieOptions = (req) => {
    const isProd = process.env.NODE_ENV === 'production';
    const origin = req.get('origin');
    
    // Check if it's localhost development
    const isLocalhost = origin && (origin.includes('localhost') || origin.includes('127.0.0.1'));
    
    // Cross-domain logic for production/external testing
    const isCrossDomain = origin && !origin.includes(req.get('host'));

    // Bypassing 'secure' for localhost as browsers block 'secure' cookies on HTTP
    const useSecure = isProd || (isCrossDomain && !isLocalhost);

    return {
        httpOnly: true,
        secure: useSecure,
        sameSite: useSecure ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    };
};



/**
 * Initial Registration - Creates a pending user and sends OTP.
 */
exports.register = catchAsync(async (req, res) => {
    const { name, phone, mpin, email, role,
        companyName, businessAddress, businessCity, businessState, businessPinCode, businessLogoUrl
    } = req.body;

    logger.info('Registration initiated', { phone, role });

    // Sanitize input
    const sanitizedName = name.trim();
    const sanitizedEmail = email?.trim() || '';

    // Check if user already exists
    let user = await User.findOne({ phone });

    // If user exists and is already verified, trigger login logic elsewhere
    if (user && user.isVerified) {
        logger.warn('Duplicate registration attempt', { phone });
        throw new AppError('User already exists. Please login.', 400);
    }

    // Hash the MPIN
    const hashedMpin = await bcrypt.hash(mpin.toString(), 12);

    if (!user) {
        // Create new pending user
        user = new User({
            name: sanitizedName,
            phone,
            mpin: hashedMpin,
            email: sanitizedEmail,
            isVerified: false,
            role: role === 'employee' ? 'unassigned' : (role || 'user')
        });
        if (role === 'captain') {
            user.companyName = companyName || '';
            user.businessAddress = businessAddress || '';
            user.businessCity = businessCity || '';
            user.businessState = businessState || '';
            user.businessPinCode = businessPinCode || '';
            user.businessLogoUrl = businessLogoUrl || null;
        }
    } else {
        // Update the unverified user with new details
        user.name = sanitizedName;
        user.mpin = hashedMpin;
        user.email = sanitizedEmail;
        user.role = role === 'employee' ? 'unassigned' : (role || user.role || 'user');
        if (role === 'captain') {
            user.companyName = companyName || '';
            user.businessAddress = businessAddress || '';
            user.businessCity = businessCity || '';
            user.businessState = businessState || '';
            user.businessPinCode = businessPinCode || '';
            user.businessLogoUrl = businessLogoUrl || null;
        }
    }

    await user.save();

    // ── TEMPORARY BYPASS: skip OTP and auto-verify ──
    // ⚠️ HARDCODED TO TRUE to unblock client registrations while MSG91 delivery is investigated.
    // TODO: Revert to `process.env.BYPASS_OTP === 'true'` once MSG91 is confirmed reliable.
    // Original line: const bypassOtp = process.env.BYPASS_OTP === 'true' || process.env.BYPASS_OTP === '1';
    const bypassOtp = true;
    if (bypassOtp) {
        user.isVerified = true;
        await user.save();

        const token = jwt.sign(
            { id: user._id, name: user.name, role: user.role, phone: user.phone },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.cookie('token', token, getCookieOptions(req));
        logger.info('OTP bypassed — user auto-verified', { phone, role: user.role });
        return res.json({ message: 'Registered and logged in (OTP bypassed)', bypassed: true, user: { id: user._id, name: user.name, role: user.role } });
    }

    // Send MSG91 Verification
    await msg91Service.sendVerification(phone);
    logger.info('OTP sent successfully', { phone });

    res.json({ message: 'Verification OTP sent to your phone' });
});

/**
 * Verify Registration/Reset OTP and log the user in.
 */
exports.verifyOtp = catchAsync(async (req, res) => {
    const { phone, code } = req.body;

    logger.info('OTP verification initiated', { phone });

    // Verify with MSG91
    const isApproved = await msg91Service.checkVerification(phone, code);
    if (!isApproved) {
        logger.warn('Invalid OTP attempt', { phone });
        throw new AppError('Invalid or expired OTP', 401);
    }

    // Fetch user
    const user = await User.findOne({ phone });
    if (!user) {
        logger.warn('User not found for OTP verification', { phone });
        throw new AppError('User not found', 404);
    }

    // Update user
    user.isVerified = true;
    await user.save();

    // Generate Token
    const token = jwt.sign(
        { id: user._id, name: user.name, role: user.role, phone: user.phone },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );

    // Set Cookie
    res.cookie('token', token, getCookieOptions(req));
    logger.info('User verified successfully', { userId: user._id, phone });

    // Fire-and-forget auto-link — never delays the verify response
    tryAutoLinkLeadGen(user).catch(() => {});

    res.json({
        message: 'Verification successful',
        user: {
            id: user._id,
            name: user.name,
            role: user.role
        }
    });
});

/**
 * Sign-In using Phone + MPIN only.
 * Security: Uses generic error messages to prevent account enumeration.
 */
exports.login = catchAsync(async (req, res) => {
    const { phone, mpin } = req.body;

    logger.info('Login attempt', { phone });

    // Generic error message for all failure cases (prevents account enumeration)
    const GENERIC_ERROR = 'Invalid phone or MPIN';

    const user = await User.findOne({ phone, isVerified: true });
    if (!user) {
        logger.warn('Login failed: user not found or unverified', { phone });
        throw new AppError(GENERIC_ERROR, 401);
    }

    // Check MPIN
    const isMatch = await bcrypt.compare(mpin.toString(), user.mpin);
    if (!isMatch) {
        logger.warn('Login failed: invalid MPIN', { userId: user._id });
        throw new AppError(GENERIC_ERROR, 401);
    }

    // Check if user is active
    if (!user.isActive) {
        logger.warn('Login failed: account deactivated', { userId: user._id });
        throw new AppError('Account is deactivated', 403);
    }

    // Generate Token
    const token = jwt.sign(
        { id: user._id, name: user.name, role: user.role, phone: user.phone },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );

    // Set Cookie
    res.cookie('token', token, getCookieOptions(req));
    logger.info('User logged in successfully', { userId: user._id, phone });

    // Fire-and-forget auto-link — never delays the login response
    tryAutoLinkLeadGen(user).catch(() => {});

    res.json({
        message: 'Login successful',
        user: {
            id: user._id,
            name: user.name,
            role: user.role
        }
    });
});

/**
 * Forgot MPIN - Send Verification OTP.
 */
exports.forgotMpin = catchAsync(async (req, res) => {
    const { phone } = req.body;
    logger.info('Forgot MPIN initiated', { phone });

    const user = await User.findOne({ phone, isVerified: true });
    if (!user) {
        logger.warn('Forgot MPIN: user not found', { phone });
        throw new AppError('User not found', 404);
    }

    await msg91Service.sendVerification(phone);
    logger.info('MPIN reset OTP sent', { userId: user._id });

    res.json({ message: 'Verification OTP sent for MPIN reset' });
});

/**
 * Reset MPIN - After OTP Verification.
 */
exports.resetMpin = catchAsync(async (req, res) => {
    const { phone, code, newMpin } = req.body;
    logger.info('MPIN reset initiated', { phone });

    // Verify code
    const isApproved = await msg91Service.checkVerification(phone, code);
    if (!isApproved) {
        logger.warn('MPIN reset: invalid OTP', { phone });
        throw new AppError('Invalid or expired OTP', 401);
    }

    const user = await User.findOne({ phone });
    if (!user) {
        logger.warn('MPIN reset: user not found', { phone });
        throw new AppError('User not found', 404);
    }

    // Update MPIN
    user.mpin = await bcrypt.hash(newMpin.toString(), 12);
    await user.save();
    logger.info('MPIN reset successfully', { userId: user._id });

    res.json({ message: 'MPIN reset successful. Please login.' });
});

/**
 * Get current user profile.
 * Authenticated via 'protect' middleware.
 */
exports.getMe = catchAsync(async (req, res) => {
    res.json({
        user: req.user
    });
});

/**
 * Get current session info (SILENT version for initial check).
 * Does NOT return 401 if unauthenticated.
 */
exports.getSession = catchAsync(async (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        return res.json({ authenticated: false, user: null });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id)
            .select('-mpin')
            .populate('employerId', 'name phone role');

        if (!user || !user.isActive) {
            return res.json({ authenticated: false, user: null });
        }

        res.json({ 
            authenticated: true, 
            user: {
                id: user._id,
                name: user.name,
                role: user.role,
                phone: user.phone,
                email: user.email,
                employerId: user.employerId ? {
                    id: user.employerId._id,
                    name: user.employerId.name,
                    role: user.employerId.role
                } : null,
                isEmployerConfirmed: user.isEmployerConfirmed,
                companyName: user.companyName || '',
                ...(user.role === 'captain' && {
                    businessLogoUrl: user.businessLogoUrl || null,
                    businessCity:    user.businessCity    || '',
                    businessState:   user.businessState   || '',
                })
            }
        });
    } catch (error) {
        // Log error silently internal to server, but send success status to frontend
        console.log('[Silent Session Check] Unauthenticated or Expired Token');
        res.json({ authenticated: false, user: null });
    }
});

/**
 * Logout - Clear Cookie.
 */
exports.logout = (req, res) => {
    res.clearCookie('token', getCookieOptions(req));
    logger.info('User logged out', { userId: req.user?.id });
    res.json({ message: 'Logged out successfully' });
};
