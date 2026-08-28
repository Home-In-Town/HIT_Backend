const User = require('../models/User');
const Logger = require('../utils/logger');

const logger = new Logger('Referral');

// How many successful referrals are needed to unlock the course
const REFERRAL_GOAL = 10;

/**
 * Base URL used to build the shareable referral link.
 * Prefers an explicit env var, else falls back to the app's public site.
 */
function referralBaseUrl() {
    return (process.env.PUBLIC_APP_URL || 'https://homeintown.in').replace(/\/+$/, '');
}

/**
 * Ensure the given user has a referral code, generating one lazily if missing
 * (backfills accounts created before the referral system existed).
 * Returns the (possibly newly-created) code.
 */
async function ensureReferralCode(userId) {
    const user = await User.findById(userId).select('referralCode');
    if (user && user.referralCode) return user.referralCode;

    const code = await User.generateUniqueReferralCode();
    await User.findByIdAndUpdate(userId, { $set: { referralCode: code } });
    return code;
}

/**
 * GET /api/referrals/me
 * Returns the caller's referral code, shareable link, referred-user history,
 * progress toward the goal, and whether the course is unlocked.
 * Auto-unlocks the course once the goal is reached.
 */
exports.getMyReferrals = async (req, res) => {
    try {
        const userId = req.user._id;

        const code = await ensureReferralCode(userId);

        // People this user has referred — newest first
        const referred = await User.find({ referredBy: userId })
            .select('name phone role isVerified referredAt createdAt')
            .sort({ referredAt: -1, createdAt: -1 })
            .lean();

        // A referral "counts" once the referred user has verified/joined
        const joined = referred.filter(u => u.isVerified);
        const count = joined.length;

        // Auto-unlock when the goal is met (persist it)
        const current = await User.findById(userId).select('courseUnlocked');
        let unlocked = !!current.courseUnlocked;
        if (!unlocked && count >= REFERRAL_GOAL) {
            await User.findByIdAndUpdate(userId, { $set: { courseUnlocked: true } });
            unlocked = true;
            logger.info('Course unlocked via referrals', { userId: userId.toString(), count });
        }

        const link = `${referralBaseUrl()}/join?ref=${encodeURIComponent(code)}`;

        // Mask phone numbers for privacy in the history list
        const maskPhone = (p) => {
            if (!p) return '';
            const digits = String(p).replace(/\D/g, '');
            if (digits.length < 4) return p;
            return `••••••${digits.slice(-4)}`;
        };

        return res.json({
            referralCode: code,
            referralLink: link,
            goal: REFERRAL_GOAL,
            count,
            remaining: Math.max(0, REFERRAL_GOAL - count),
            courseUnlocked: unlocked,
            referrals: referred.map(u => ({
                id: u._id.toString(),
                name: u.name || 'New member',
                phone: maskPhone(u.phone),
                role: u.role,
                joined: !!u.isVerified,
                joinedAt: u.referredAt || u.createdAt,
            })),
        });
    } catch (err) {
        logger.error('getMyReferrals error', { error: err.message });
        return res.status(500).json({ error: err.message });
    }
};

module.exports = exports;
