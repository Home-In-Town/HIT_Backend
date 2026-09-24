const mongoose = require('mongoose');
const ProjectService = require('../services/ProjectService');
const User = require('../models/User');
const Project = require('../models/Project');
const reverseMatchService = require('../services/ReverseMatchService');

/**
 * Fields a generic PUT /:projectId must never be allowed to set.
 *
 * ProjectRepository.update flattens the body straight into $set, so before this
 * list existed a caller could pass `owner` and reassign someone else's project
 * to themselves. Each of these has its own purpose-built, role-gated endpoint
 * (assign-captain / assign-co-captain / assign-agent), so stripping them here
 * removes the takeover vector without removing any capability.
 */
const IMMUTABLE_PROJECT_FIELDS = ['_id', 'id', 'owner', 'coCaptains', 'assignedAgent', 'createdAt', 'updatedAt'];

/**
 * Authorise a mutation against a specific project.
 *
 * Every /:projectId mutation sits behind `protect`, but until now none of them
 * compared req.user to the project — so ANY authenticated account (including the
 * default role handed out at signup) could edit or hard-delete ANY project.
 *
 * Admins always pass. Otherwise the caller must be the owner, a co-captain, or
 * the assigned agent — mirroring the checks already used in
 * organizationController and humanLeadController.
 *
 * @returns {{ project?: object, error?: { code: number, message: string } }}
 */
async function authorizeProjectAccess(req, projectId) {
  if (!mongoose.Types.ObjectId.isValid(String(projectId))) {
    return { error: { code: 400, message: 'Invalid project id' } };
  }

  const project = await Project.findById(projectId)
    .select('owner coCaptains assignedAgent projectName status')
    .lean();
  if (!project) return { error: { code: 404, message: 'Project not found' } };

  if (req.user?.role === 'admin') return { project };

  const uid = String(req.user?._id || req.user?.id || '');
  if (!uid) return { error: { code: 401, message: 'Not authenticated' } };

  const isOwner = project.owner && String(project.owner) === uid;
  const isCoCaptain = (project.coCaptains || []).some((c) => String(c) === uid);
  const isAssignedAgent = project.assignedAgent && String(project.assignedAgent) === uid;

  if (isOwner || isCoCaptain || isAssignedAgent) return { project };
  return { error: { code: 403, message: 'You do not have permission to modify this project' } };
}
const {
  ensureProjectGroup,
  syncProjectGroup,
  deactivateProjectGroup
} = require('../services/UniversalGroupService');

/**
 * Fire-and-forget group sync that still reports failures.
 *
 * Group creation used to happen only as a side effect of lead matching, with
 * errors fully swallowed — so a project could silently end up with no group and
 * nothing anywhere said so. It is still non-blocking (a group problem must never
 * fail a project write), but every outcome is now logged.
 */
function syncGroupForProject(projectOrId, io, context) {
  Promise.resolve()
    .then(() => ensureProjectGroup(projectOrId, io))
    .then((result) => {
      if (!result) {
        const id = projectOrId?._id || projectOrId?.id || projectOrId;
        console.warn(`[ProjectGroup] ${context}: no group created for project ${id}`);
      } else if (result.isNew) {
        console.log(`[ProjectGroup] ${context}: created group ${result.room._id} for project ${result.project._id}`);
      }
    })
    .catch((err) => {
      console.error(`[ProjectGroup] ${context} failed:`, err.message);
    });
}

/**
 * Fire-and-forget: Notify OneEmployee of project changes for linked users.
 * Never throws — safe to call in any context without try-catch.
 */
async function notifyProjectUpdate(userId, projectId, action, projectName) {
    try {
        if (!userId) return;
        const user = await User.findById(userId).select('oneEmployeeLinked oneEmployeeOwnerId').lean();
        if (!user || !user.oneEmployeeLinked || !user.oneEmployeeOwnerId) return;

        const LEADGEN_URL = process.env.LEADGEN_BACKEND_URL || 'https://lead-filteration-backend-624770114041.asia-south1.run.app';
        const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';
        const axios = require('axios');

        await axios.post(`${LEADGEN_URL}/api/internal/project-sync`, {
            ownerId: user.oneEmployeeOwnerId,
            hitUserId: userId.toString(),
            projectId: projectId.toString(),
            action,
            projectName: projectName || ''
        }, {
            headers: { 'x-internal-secret': INTERNAL_SECRET },
            timeout: 5000
        }).catch(() => {}); // swallow errors — never block project operations
    } catch { /* silent */ }
}

class ProjectController {
  async getAll(req, res) {
    try {
      const user = req.user;
      let projects;

      if (!user || user.role === 'admin') {
        // Admin or unauthenticated: return all projects
        projects = await ProjectService.getAllProjects();
      } else if (user.role === 'builder' || user.role === 'agent' || user.role === 'captain') {
        // Builder or Agent: return only their owned projects
        projects = await ProjectService.getProjectsByOwner(user.id);
      } else if (user.role === 'employee') {
        // Employee: return projects assigned to them
        projects = await ProjectService.getProjectsAssignedToAgent(user.id);
      } else {
        projects = [];
      }

      res.json(projects);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getOne(req, res) {
    try {
      const project = await ProjectService.getProjectById(req.params.projectId);
      if (!project) return res.status(404).json({ message: 'Project not found' });
      res.json(project);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async create(req, res) {
    try {
      const user = req.user;
      const projectData = { ...req.body };

      // Attach the owner (builder or agent) ID
      if (user && (user.role === 'builder' || user.role === 'agent' || user.role === 'admin' || user.role === 'captain')) {
        projectData.owner = user.id;
      }

      const project = await ProjectService.createProject(projectData);

      // Every property gets its group at birth, not when a lead happens to
      // match it. Idempotent, so publish/update calling this again is harmless.
      syncGroupForProject(project.id || project._id, req.app.get('io'), 'create');

      // Notify OneEmployee (fire-and-forget)
      notifyProjectUpdate(user?.id, project._id, 'created', project.projectName);

      res.status(201).json(project);
    } catch (error) {
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          message: 'Validation failed',
          errors: Object.values(error.errors).map(e => e.message),
        });
      }
      res.status(500).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const { error: authError } = await authorizeProjectAccess(req, req.params.projectId);
      if (authError) return res.status(authError.code).json({ message: authError.message });

      // Never let a generic update reassign ownership (see IMMUTABLE_PROJECT_FIELDS).
      const updates = { ...req.body };
      for (const field of IMMUTABLE_PROJECT_FIELDS) delete updates[field];

      // Snapshot buyer-facing fields BEFORE the update so we can detect whether
      // the edit is significant enough to announce (price/status/config/media).
      const beforeSnapshot = await Project.findById(req.params.projectId)
        .select('pricing.startingPrice projectStatus configuration.bhkOptions media.galleryImages media.coverImage')
        .lean();

      const project = await ProjectService.updateProject(req.params.projectId, updates);
      if (!project) return res.status(404).json({ message: 'Project not found' });

      // Refresh the group's name and pinned property details so the group always
      // reflects the latest data. Self-heals a missing group too.
      Promise.resolve()
        .then(() => syncProjectGroup(req.params.projectId, req.app.get('io')))
        .catch((err) => console.error('[ProjectGroup] update sync failed:', err.message));

      // Notify OneEmployee (fire-and-forget)
      notifyProjectUpdate(project.owner, project._id, 'updated', project.projectName);

      // Fire-and-forget post-edit side effects. Fetch the full, owner-populated
      // project once and reuse it for both the pin refresh and reverse matching.
      {
        const projectId = project.id || project._id;
        const io = req.app.get('io');
        Project.findById(projectId)
          .populate('owner', 'name companyName role verificationStatus rating ratingCount')
          .lean()
          .then(async (fullProject) => {
            if (!fullProject) return;

            const {
              refreshProjectSubGroupPin,
              detectSignificantChanges,
              postProjectAnnouncement
            } = require('../services/UniversalGroupService');

            // Always refresh the sub-group pinned message so it reflects the
            // current project (price, type, plot size, BHK) instead of freezing
            // at sub-group creation.
            await refreshProjectSubGroupPin(fullProject, io).catch(() => {});

            // Re-run reverse matching only for live inventory — draft edits
            // shouldn't surface as matches.
            if (fullProject.status === 'published') {
              await reverseMatchService.onProjectPublished(fullProject, io);

              // Announce an "Updated" card only for significant, buyer-facing
              // changes on live projects — minor edits just refresh the pin.
              const changes = detectSignificantChanges(beforeSnapshot, fullProject);
              if (changes.length > 0) {
                await postProjectAnnouncement(fullProject, 'updated', io, changes).catch(() => {});
              }
            }
          })
          .catch(err => {
            console.error('Post-update side effects (non-blocking) error:', err.message);
          });
      }

      res.json(project);
    } catch (error) {
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          message: 'Validation failed',
          errors: Object.values(error.errors).map(e => e.message),
        });
      }
      res.status(500).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      // This is a HARD delete (ProjectRepository.delete → findByIdAndDelete), so
      // the ownership check matters more here than anywhere else.
      const { project: projectBefore, error: authError } =
        await authorizeProjectAccess(req, req.params.projectId);
      if (authError) return res.status(authError.code).json({ message: authError.message });

      const success = await ProjectService.deleteProject(req.params.projectId);
      if (!success) return res.status(404).json({ message: 'Project not found' });

      // Cascade: close the property's group. The project row is hard-deleted, so
      // without this the group survives as an orphan pointing at a dead project
      // and keeps showing up in Discover. Awaited (it is a single updateMany) so
      // there is no window where the group outlives the project, but never fatal.
      try {
        await deactivateProjectGroup(req.params.projectId, req.app.get('io'));
      } catch (groupErr) {
        console.error('[ProjectGroup] delete cascade failed:', groupErr.message);
      }

      // Notify OneEmployee (fire-and-forget)
      if (projectBefore) {
          notifyProjectUpdate(projectBefore.owner, req.params.projectId, 'deleted', projectBefore.projectName);
      }

      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async publish(req, res) {
    try {
      const { error: authError } = await authorizeProjectAccess(req, req.params.projectId);
      if (authError) return res.status(authError.code).json({ message: authError.message });

      const project = await ProjectService.publishProject(req.params.projectId);

      // Fire-and-forget: run reverse matching against recent leads
      const fullProject = await Project.findById(project._id)
        .populate('owner', 'name companyName role verificationStatus rating ratingCount')
        .lean();
      const io = req.app.get('io');

      // Publishing previously created no group at all — it only fired reverse
      // matching, which notifies agents but never creates a group. This closes
      // that gap for projects created before the create-time hook existed.
      syncGroupForProject(fullProject, io, 'publish');

      reverseMatchService.onProjectPublished(fullProject, io).catch(err => {
        console.error('ReverseMatch (publish) non-blocking error:', err.message);
      });

      // Fire-and-forget: post a persistent "New Project" announcement card into
      // the HIT Community room so everyone sees the launch.
      {
        const { postProjectAnnouncement } = require('../services/UniversalGroupService');
        postProjectAnnouncement(fullProject, 'new', io).catch(err => {
          console.error('postProjectAnnouncement (publish) non-blocking error:', err.message);
        });
      }

      res.json(project);
    } catch (error) {
      if (error.message === 'Project not found') {
        return res.status(404).json({ message: error.message });
      }
      res.status(500).json({ message: error.message });
    }
  }

  async getOneBySlug(req, res) {
    try {
      const project = await ProjectService.getPublicProject(req.params.slug);
      if (!project) return res.status(404).json({ message: 'Page not found' });
      res.json(project);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getAllPublic(req, res) {
    try {
      const projects = await ProjectService.getPublicProjects();
      res.json(projects);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Get projects by owner phone (builder or agent)
  async getProjectsByOwnerPhone(req, res) {
    try {
      const { phone } = req.params;

      // Find User (builder or agent) by phone
      const user = await User.findOne({
        phone: phone,
        role: { $in: ['builder', 'agent', 'admin'] }
      });

      if (!user) {
        return res.status(404).json({ message: 'User not found with this phone number' });
      }

      // Find Projects owned by this user
      const projects = await Project.find({
        owner: user._id,
        status: { $ne: 'deleted' }
      })
        .select('projectName slug _id coverImage city')
        .sort('createdAt')
        .limit(200)
        .lean();

      res.status(200).json({
        builder: {
          name: user.name,
          id: user._id
        },
        projects
      });

    } catch (error) {
      console.error('Error fetching owner projects:', error);
      res.status(500).json({ message: error.message });
    }
  }

  // Get projects by owner ID (Public Portfolio)
  async getProjectsByOwnerId(req, res) {
    try {
      const { ownerId } = req.params;

      // Helper: Check if string is valid MongoDB ObjectId
      const isValidObjectId = (str) => {
        return /^[0-9a-fA-F]{24}$/.test(str);
      };

      let user;

      // 1. Find User (Builder/Agent)
      if (isValidObjectId(ownerId)) {
        // Try to find by primary ID first
        user = await User.findById(ownerId);
      }

      // If not found by ID (or invalid ObjectId), try other fields
      if (!user) {
        user = await User.findOne({
          $or: [
            { oldId: ownerId },
            { builderCode: ownerId }
          ]
        });
      }

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // 2. Find Projects owned by this user.
      // Public endpoint: bounded and lean so an owner with a large portfolio
      // can't be used to pull unbounded full Mongoose documents.
      const projects = await Project.find({
        owner: user._id,
        status: { $ne: 'deleted' }
      })
        .select('projectName slug _id coverImage city startingPrice')
        .sort('createdAt')
        .limit(200)
        .lean();

      res.status(200).json({
        builder: {
          name: user.name,
          id: user._id,
          companyName: user.companyName
        },
        projects
      });

    } catch (error) {
      console.error('Error fetching owner portfolio:', error);
      res.status(500).json({ message: error.message });
    }
  }


  // Verify User by Phone (Agent/Builder/Admin)
  async verifyUserByPhone(req, res) {
    try {
      const { phone } = req.params;

      const user = await User.findOne({ phone: phone });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      res.status(200).json({
        id: user._id,
        name: user.name,
        role: user.role,
        companyName: user.companyName
      });

    } catch (error) {
      console.error('Error verifying user:', error);
      res.status(500).json({ message: error.message });
    }
  }

  // Save landmarks
  async saveLandmarks(req, res) {
    try {
      const { projectId } = req.params;
      const { error: authError } = await authorizeProjectAccess(req, projectId);
      if (authError) return res.status(authError.code).json({ message: authError.message });

      let { landmarks } = req.body;

      // Parse if accidentally sent as a JSON string
      if (typeof landmarks === 'string') {
        try { landmarks = JSON.parse(landmarks); } catch { landmarks = []; }
      }

      if (!Array.isArray(landmarks)) {
        return res.status(400).json({ message: 'landmarks must be an array' });
      }

      // Sanitize: each item must be a plain object, not a stringified one
      landmarks = landmarks.map((item) => {
        if (typeof item === 'string') {
          try { return JSON.parse(item); } catch { return null; }
        }
        return item;
      }).filter(Boolean);

      const saved = await ProjectService.saveProjectLandmarks(projectId, landmarks);
      res.status(200).json({ landmarks: saved });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Save layout entities (map polygons, plots, roads, boundaries)
  async saveLayoutEntities(req, res) {
    try {
      const { projectId } = req.params;
      const { error: authError } = await authorizeProjectAccess(req, projectId);
      if (authError) return res.status(authError.code).json({ message: authError.message });

      let { layoutEntities } = req.body;

      if (typeof layoutEntities === 'string') {
        try { layoutEntities = JSON.parse(layoutEntities); } catch { layoutEntities = []; }
      }

      if (!Array.isArray(layoutEntities)) {
        return res.status(400).json({ message: 'layoutEntities must be an array' });
      }

      const saved = await ProjectService.saveLayoutEntities(projectId, layoutEntities);
      res.status(200).json({ layoutEntities: saved });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async assignCaptain(req, res) {
    try {
      const { projectId } = req.params;
      const { captainId } = req.body;

      const result = await ProjectService.assignCaptainToProject(projectId, captainId);
      res.json(result);
    } catch (error) {
      if (error.message === 'Project not found') {
        return res.status(404).json({ message: error.message });
      }
      if (error.message === 'Invalid captain') {
        return res.status(400).json({ message: 'The specified user is not a valid captain' });
      }
      res.status(500).json({ message: error.message });
    }
  }

  // Add or remove a co-captain (second captain) on a project. Body: { captainId, action: 'add'|'remove' }
  async assignCoCaptain(req, res) {
    try {
      const { projectId } = req.params;
      const { captainId, action } = req.body;

      const result = await ProjectService.assignCoCaptainToProject(projectId, captainId, action === 'remove' ? 'remove' : 'add');
      res.json(result);
    } catch (error) {
      if (error.message === 'Project not found') {
        return res.status(404).json({ message: error.message });
      }
      if (error.message === 'Invalid captain') {
        return res.status(400).json({ message: 'The specified user is not a valid captain' });
      }
      if (error.message === 'captainId is required' || error.message.includes('already the primary')) {
        return res.status(400).json({ message: error.message });
      }
      res.status(500).json({ message: error.message });
    }
  }

  async getCaptains(req, res) {
    try {
      const captains = await User.find({ role: 'captain' })
        .select('_id name phone companyName')
        .sort({ name: 1 })
        .lean();
      res.json(captains);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Get agents (employees) under the logged-in captain
  async getMyAgents(req, res) {
    try {
      const agents = await User.find({
        employerId: req.user._id,
        isEmployerConfirmed: true,
        role: 'employee'
      })
        .select('_id name phone')
        .sort({ name: 1 })
        .lean();
      res.json(agents);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Assign/reassign/unassign an agent to a project (captain only)
  async assignAgent(req, res) {
    try {
      const { projectId } = req.params;
      const { agentId } = req.body; // null = unassign

      const result = await ProjectService.assignAgentToProject(projectId, agentId, req.user._id.toString());
      res.json(result);
    } catch (error) {
      if (error.message === 'Not authorized') {
        return res.status(403).json({ message: 'You do not own this project' });
      }
      if (error.message === 'Project not found') {
        return res.status(404).json({ message: error.message });
      }
      if (error.message === 'Invalid agent' || error.message === 'Agent not under your team') {
        return res.status(400).json({ message: error.message });
      }
      res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new ProjectController();
