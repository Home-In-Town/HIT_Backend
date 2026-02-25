const ProjectService = require('../services/ProjectService');
const Organization = require('../models/Organization');
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
      } else if (user.role === 'builder') {
        // Builder: return only their projects
        projects = await ProjectService.getProjectsByBuilder(user.id);
      } else if (user.role === 'agent') {
        // Agent: return projects from their organizations
        projects = await ProjectService.getProjectsForAgent(user.id);
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

      // If builder is creating, attach their ID
      if (user && (user.role === 'builder' || user.role === 'admin')) {
        projectData.builderId = user.id;
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

  // Get projects by builder phone
  async getProjectsByBuilderPhone(req, res) {
    try {
      const { phone } = req.params;

      // 1. Find User (Builder) by phone
      // We look for any user with this phone who is a builder or admin
      const user = await User.findOne({
        phone: phone,
        role: { $in: ['builder', 'admin'] }
      });

      if (!user) {
        return res.status(404).json({ message: 'Builder not found with this phone number' });
      }

      // 2. Find Projects for this Builder
      const projects = await Project.find({
        builderId: user._id,
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
      console.error('Error fetching builder projects:', error);
      res.status(500).json({ message: error.message });
    }
  }

  // Get projects by builder ID (Public Portfolio)
  async getProjectsByBuilderId(req, res) {
    try {
      const { builderId } = req.params;

      // 1. Find User (Builder)
      const user = await User.findOne({ _id: builderId }); // Use _id directly

      if (!user) {
        return res.status(404).json({ message: 'Builder not found' });
      }

      // 2. Find Projects for this Builder
      const projects = await Project.find({
        builderId: user._id,
        status: { $ne: 'deleted' }
      })
        .select('projectName slug _id coverImage city startingPrice') // Add needed fields
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
      console.error('Error fetching builder portfolio:', error);
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
      const { landmarks } = req.body;

      if (!Array.isArray(landmarks)) {
        return res.status(400).json({ message: 'landmarks must be an array' });
      }
      console.log("LANDMARKS RECEIVED:", req.body.landmarks);
console.log("TYPE:", typeof req.body.landmarks);
console.log("IS ARRAY:", Array.isArray(req.body.landmarks));
      const saved = await ProjectService.saveProjectLandmarks(projectId, landmarks);
      res.status(200).json({ landmarks: saved });
    } catch (error) {
      console.error('Error saving landmarks:', error);
      res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new ProjectController();
