const ProjectService = require('../services/ProjectService');

class ProjectController {
  async getAll(req, res) {
    try {
      const projects = await ProjectService.getAllProjects();
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
      const project = await ProjectService.createProject(req.body);
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
}

module.exports = new ProjectController();
