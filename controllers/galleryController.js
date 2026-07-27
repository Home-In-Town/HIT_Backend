const { ZipArchive } = require('archiver');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');
const { r2 } = require('../config/r2');
const Project = require('../models/Project');
const User = require('../models/User');
const axios = require('axios');

class GalleryController {
  /**
   * Download all project media as a ZIP file.
   * Includes: cover image, gallery images, videos, brochure, layout image
   * Also includes a contact card (vCard + text) of the authenticated user.
   *
   * GET /api/share/gallery/:projectId
   * Auth required — contact details come from the logged-in user.
   */
  async downloadGallery(req, res) {
    try {
      const { projectId } = req.params;
      const userId = req.user._id;

      console.log(`[Gallery] Starting download for project=${projectId}, user=${userId}`);

      // Fetch project
      const project = await Project.findById(projectId);
      if (!project) {
        console.log('[Gallery] Project not found:', projectId);
        return res.status(404).json({ error: 'Project not found' });
      }
      console.log(`[Gallery] Project found: ${project.projectName}, media keys:`, Object.keys(project.media || {}));

      // Fetch user contact info
      const user = await User.findById(userId).select(
        'name phone email companyName businessLogoUrl businessAddress businessCity businessState businessPinCode role'
      );
      if (!user) {
        console.log('[Gallery] User not found:', userId);
        return res.status(404).json({ error: 'User not found' });
      }
      console.log(`[Gallery] User found: ${user.name}`);

      // Collect all media URLs
      const mediaFiles = [];
      const getUrl = (fileObj) => {
        if (!fileObj) return null;
        if (typeof fileObj === 'string') return fileObj;
        return fileObj.url || null;
      };
      const getKey = (fileObj) => {
        if (!fileObj) return null;
        if (typeof fileObj === 'object' && fileObj.key) return fileObj.key;
        return null;
      };

      // Cover image
      if (project.media?.coverImage) {
        mediaFiles.push({
          name: 'Cover_Image',
          url: getUrl(project.media.coverImage),
          key: getKey(project.media.coverImage),
        });
      }

      // Gallery images
      if (project.media?.galleryImages?.length) {
        project.media.galleryImages.forEach((img, i) => {
          mediaFiles.push({
            name: `Gallery_${i + 1}`,
            url: getUrl(img),
            key: getKey(img),
          });
        });
      }

      // Videos
      if (project.media?.videos?.length) {
        project.media.videos.forEach((vid, i) => {
          mediaFiles.push({
            name: `Video_${i + 1}`,
            url: getUrl(vid),
            key: getKey(vid),
            isVideo: true,
          });
        });
      }

      // Brochure
      if (project.media?.brochurePdf) {
        mediaFiles.push({
          name: 'Brochure',
          url: getUrl(project.media.brochurePdf),
          key: getKey(project.media.brochurePdf),
          isBrochure: true,
        });
      }

      // Layout image
      if (project.media?.layoutImage) {
        mediaFiles.push({
          name: 'Layout',
          url: getUrl(project.media.layoutImage),
          key: getKey(project.media.layoutImage),
        });
      }

      if (mediaFiles.length === 0) {
        return res.status(400).json({ error: 'No media found for this project' });
      }

      console.log(`[Gallery] Found ${mediaFiles.length} media files to archive`);
      mediaFiles.forEach(f => console.log(`  - ${f.name}: key=${f.key || 'none'}, url=${f.url ? 'yes' : 'none'}`));

      // Build project folder name
      const projectName = (project.projectName || 'Project').replace(/[^a-zA-Z0-9\s-]/g, '').trim();
      const zipFileName = `${projectName}_Gallery.zip`;

      // Set response headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

      // Create archive
      const archive = new ZipArchive({ zlib: { level: 5 } });

      archive.on('error', (err) => {
        console.error('Archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to create archive' });
        }
      });

      // Pipe archive to response
      archive.pipe(res);

      // Add contact card (text file)
      const contactText = this._buildContactText(user, project);
      archive.append(contactText, { name: `${projectName}/Contact_Details.txt` });

      // Add vCard
      const vCard = this._buildVCard(user);
      archive.append(vCard, { name: `${projectName}/Contact.vcf` });

      // Download and add each media file
      for (const file of mediaFiles) {
        try {
          const ext = this._getExtension(file.url, file);
          const fileName = `${projectName}/${file.name}${ext}`;

          if (file.key) {
            // Fetch from R2 using key
            const command = new GetObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: file.key,
            });
            const response = await r2.send(command);
            if (response.Body) {
              // AWS SDK v3 returns a web ReadableStream or Node stream depending on env
              // Convert to Node.js Readable if needed
              let stream;
              if (response.Body instanceof Readable) {
                stream = response.Body;
              } else if (response.Body.transformToByteArray) {
                const bytes = await response.Body.transformToByteArray();
                stream = Buffer.from(bytes);
              } else {
                stream = response.Body;
              }
              archive.append(stream, { name: fileName });
            }
          } else if (file.url) {
            // Fetch from URL using axios
            const response = await axios.get(file.url, {
              responseType: 'arraybuffer',
              timeout: 30000,
            });
            archive.append(Buffer.from(response.data), { name: fileName });
          }
        } catch (fileErr) {
          console.error(`Failed to add file ${file.name}:`, fileErr.message);
          // Continue with other files even if one fails
        }
      }

      // Finalize the archive
      await archive.finalize();
    } catch (error) {
      console.error('Gallery download error:', error.message, error.stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download gallery' });
      }
    }
  }

  /**
   * Build a human-readable contact text file.
   */
  _buildContactText(user, project) {
    const lines = [
      '═══════════════════════════════════════════',
      '           SHARED BY - CONTACT DETAILS',
      '═══════════════════════════════════════════',
      '',
      `Name:        ${user.name || ''}`,
      `Phone:       ${user.phone || ''}`,
      `Email:       ${user.email || 'N/A'}`,
      `Company:     ${user.companyName || 'N/A'}`,
      `Role:        ${(user.role || '').charAt(0).toUpperCase() + (user.role || '').slice(1)}`,
      '',
    ];

    if (user.businessAddress || user.businessCity || user.businessState) {
      lines.push('--- Address ---');
      if (user.businessAddress) lines.push(`Address:     ${user.businessAddress}`);
      if (user.businessCity) lines.push(`City:        ${user.businessCity}`);
      if (user.businessState) lines.push(`State:       ${user.businessState}`);
      if (user.businessPinCode) lines.push(`Pin Code:    ${user.businessPinCode}`);
      lines.push('');
    }

    lines.push('═══════════════════════════════════════════');
    lines.push('           PROJECT DETAILS');
    lines.push('═══════════════════════════════════════════');
    lines.push('');
    lines.push(`Project:     ${project.projectName || ''}`);
    lines.push(`City:        ${project.city || ''}`);
    lines.push(`Location:    ${project.location || ''}`);
    if (project.pricing?.startingPrice) {
      const price = project.pricing.startingPrice;
      const formatted = price >= 10000000
        ? `Rs. ${(price / 10000000).toFixed(2)} Cr`
        : price >= 100000
          ? `Rs. ${(price / 100000).toFixed(1)} Lac`
          : `Rs. ${price.toLocaleString('en-IN')}`;
      lines.push(`Price:       ${formatted}`);
    }
    if (project.reraNumber) lines.push(`RERA:        ${project.reraNumber}`);
    lines.push('');
    lines.push('═══════════════════════════════════════════');
    lines.push(`  Visit: https://www.homeintown.in/visit/${project.slug || ''}`);
    lines.push('═══════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Build a vCard (.vcf) for the sharer.
   */
  _buildVCard(user) {
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${user.name || ''}`,
      `N:;${user.name || ''};;;`,
    ];

    if (user.phone) lines.push(`TEL;TYPE=CELL:${user.phone}`);
    if (user.email) lines.push(`EMAIL:${user.email}`);
    if (user.companyName) lines.push(`ORG:${user.companyName}`);
    if (user.role) lines.push(`TITLE:${user.role.charAt(0).toUpperCase() + user.role.slice(1)}`);

    const addrParts = [
      '', '', // PO Box, Extended Address
      user.businessAddress || '',
      user.businessCity || '',
      user.businessState || '',
      user.businessPinCode || '',
      'India'
    ];
    if (user.businessAddress || user.businessCity) {
      lines.push(`ADR;TYPE=WORK:${addrParts.join(';')}`);
    }

    lines.push(`NOTE:Shared via HomeInTown - www.homeintown.in`);
    lines.push('END:VCARD');

    return lines.join('\r\n');
  }

  /**
   * Get file extension from URL or type.
   */
  _getExtension(url, file) {
    if (file.isBrochure) return '.pdf';
    if (file.isVideo) {
      if (url && url.includes('.mp4')) return '.mp4';
      if (url && url.includes('.webm')) return '.webm';
      return '.mp4';
    }
    // Image — try to detect from URL
    if (url) {
      if (url.includes('.png')) return '.png';
      if (url.includes('.webp')) return '.webp';
      if (url.includes('.gif')) return '.gif';
    }
    return '.jpg';
  }
}

module.exports = new GalleryController();
