const ProjectService = require('../services/ProjectService');
const User = require('../models/User');
const Project = require('../models/Project');

class ProjectController {
  async getAll(req, res) {
    try {
      const user = req.user;
      let projects;

      if (!user || user.role === 'admin') {
        // Admin or unauthenticated: return all projects
        projects = await ProjectService.getAllProjects();
      } else if (user.role === 'builder' || user.role === 'agent') {
        // Builder or Agent: return only their owned projects
        projects = await ProjectService.getProjectsByOwner(user.id);
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
      if (user && (user.role === 'builder' || user.role === 'agent' || user.role === 'admin')) {
        projectData.owner = user.id;
      }

      const project = await ProjectService.createProject(projectData);
      res.status(201).json(project);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const project = await ProjectService.updateProject(req.params.projectId, req.body);
      if (!project) return res.status(404).json({ message: 'Project not found' });
      res.json(project);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async delete(req, res) {
    try {
      const success = await ProjectService.deleteProject(req.params.projectId);
      if (!success) return res.status(404).json({ message: 'Project not found' });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async publish(req, res) {
    try {
      const project = await ProjectService.publishProject(req.params.projectId);
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
        .sort('-createdAt');

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

      // 2. Find Projects owned by this user
      const projects = await Project.find({
        owner: user._id,
        status: { $ne: 'deleted' }
      })
        .select('projectName slug _id coverImage city startingPrice')
        .sort('-createdAt');

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
}

module.exports = new ProjectController();
