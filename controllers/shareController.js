const { v4: uuidv4 } = require('uuid');
const ShareToken = require('../models/ShareToken');
const Project = require('../models/Project');
const User = require('../models/User');

class ShareController {
  /**
   * Generate a share token for a project.
   * The authenticated captain/agent's contact details will be tied to this token.
   * 
   * POST /api/share/generate
   * Body: { projectId, type: 'link' | 'pdf' | 'qr' }
   */
  async generateToken(req, res) {
    try {
      const { projectId, type } = req.body;
      const userId = req.user._id;

      if (!projectId || !type) {
        return res.status(400).json({ error: 'projectId and type are required' });
      }

      if (!['link', 'pdf', 'qr'].includes(type)) {
        return res.status(400).json({ error: 'type must be one of: link, pdf, qr' });
      }

      // Verify project exists
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Check if an active token already exists for this user + project + type
      // Reuse it instead of creating duplicates
      let shareToken = await ShareToken.findOne({
        project: projectId,
        sharedBy: userId,
        type,
        isActive: true
      });

      if (!shareToken) {
        // Generate a short unique token (first 8 chars of uuid for cleaner URLs)
        const token = uuidv4().replace(/-/g, '').substring(0, 12);

        shareToken = await ShareToken.create({
          token,
          project: projectId,
          sharedBy: userId,
          type
        });
      }

      // Build the share URL
      const baseUrl = process.env.FRONTEND_URL
        ? process.env.FRONTEND_URL.split(',')[0].trim()
        : 'https://www.homeintown.in';

      const shareUrl = `${baseUrl}/s/${shareToken.token}`;

      res.status(200).json({
        token: shareToken.token,
        shareUrl,
        type: shareToken.type,
        projectId: shareToken.project
      });
    } catch (error) {
      console.error('Error generating share token:', error);
      res.status(500).json({ error: 'Failed to generate share token' });
    }
  }

  /**
   * Resolve a share token — returns project details + sharer's contact info.
   * This is a PUBLIC endpoint (no auth required).
   * 
   * GET /api/public/share/:token
   */
  async resolveToken(req, res) {
    try {
      const { token } = req.params;

      const shareToken = await ShareToken.findOne({ token, isActive: true })
        .populate('project')
        .populate('sharedBy', 'name phone email companyName businessLogoUrl businessAddress businessCity businessState businessPinCode role');

      if (!shareToken) {
        return res.status(404).json({ error: 'Share link not found or expired' });
      }

      // Increment view count
      shareToken.viewCount += 1;
      shareToken.lastViewedAt = new Date();
      await shareToken.save();

      // Build contact info response
      const sharer = shareToken.sharedBy;
      const contactInfo = {
        name: sharer.name,
        phone: sharer.phone,
        email: sharer.email || null,
        companyName: sharer.companyName || null,
        businessLogoUrl: sharer.businessLogoUrl || null,
        businessAddress: sharer.businessAddress || null,
        businessCity: sharer.businessCity || null,
        businessState: sharer.businessState || null,
        role: sharer.role
      };

      res.status(200).json({
        project: shareToken.project,
        sharedBy: contactInfo,
        type: shareToken.type,
        viewCount: shareToken.viewCount
      });
    } catch (error) {
      console.error('Error resolving share token:', error);
      res.status(500).json({ error: 'Failed to resolve share link' });
    }
  }

  /**
   * Get sharer's contact details for PDF generation.
   * Called internally when generating a PDF — returns the authenticated user's contact info.
   * 
   * GET /api/share/my-contact
   */
  async getMyContactForPdf(req, res) {
    try {
      const user = req.user;

      const contactInfo = {
        name: user.name,
        phone: user.phone,
        email: user.email || null,
        companyName: user.companyName || null,
        businessLogoUrl: user.businessLogoUrl || null,
        businessAddress: user.businessAddress || null,
        businessCity: user.businessCity || null,
        businessState: user.businessState || null,
        businessPinCode: user.businessPinCode || null,
        role: user.role
      };

      res.status(200).json({ contactInfo });
    } catch (error) {
      console.error('Error fetching contact for PDF:', error);
      res.status(500).json({ error: 'Failed to fetch contact info' });
    }
  }

  /**
   * Get all share tokens created by the authenticated user.
   * Useful for analytics — see how many views each shared link got.
   * 
   * GET /api/share/my-shares
   */
  async getMyShares(req, res) {
    try {
      const userId = req.user._id;

      const shares = await ShareToken.find({ sharedBy: userId, isActive: true })
        .populate('project', 'projectName slug city media.coverImage')
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({ shares });
    } catch (error) {
      console.error('Error fetching user shares:', error);
      res.status(500).json({ error: 'Failed to fetch shares' });
    }
  }

  /**
   * Deactivate a share token.
   * 
   * DELETE /api/share/:token
   */
  async deactivateToken(req, res) {
    try {
      const { token } = req.params;
      const userId = req.user._id;

      const shareToken = await ShareToken.findOne({ token, sharedBy: userId });

      if (!shareToken) {
        return res.status(404).json({ error: 'Share token not found' });
      }

      shareToken.isActive = false;
      await shareToken.save();

      res.status(200).json({ message: 'Share link deactivated' });
    } catch (error) {
      console.error('Error deactivating share token:', error);
      res.status(500).json({ error: 'Failed to deactivate share link' });
    }
  }
}

module.exports = new ShareController();
