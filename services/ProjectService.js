const ProjectRepository = require('../repositories/ProjectRepository');
const slugify = require('../utils/slugify');

class ProjectService {
  async getAllProjects() {
    return await ProjectRepository.getAll();
  }

  async getProjectById(id) {
    return await ProjectRepository.getById(id);
  }

  async createProject(data) {
    return await ProjectRepository.create(data);
  }

  async updateProject(id, data) {
    return await ProjectRepository.update(id, data);
  }

  async deleteProject(id) {
    return await ProjectRepository.delete(id);
  }

  async publishProject(id) {
    const project = await this.getProjectById(id);
    if (!project) throw new Error('Project not found');
    
    const slug = slugify(project.projectName || project.name); 
    
    return await ProjectRepository.publish(id, slug);
  }

  async getPublicProject(slug) {
    return await ProjectRepository.getBySlug(slug);
  }
}

module.exports = new ProjectService();
