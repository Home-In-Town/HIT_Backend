const ProjectRepository = require('../repositories/ProjectRepository');
const slugify = require('../utils/slugify');

class ProjectService {
  async getAllProjects() {
    return await ProjectRepository.getAll();
  }

  async getProjectById(id) {
    return await ProjectRepository.getById(id);
  }

  /**
   * Get projects owned by a specific user (builder or agent)
   */
  async getProjectsByOwner(ownerId) {
    return await ProjectRepository.getByOwner(ownerId);
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

  async getPublicProjects() {
    return await ProjectRepository.getPublished();
  }

  async saveProjectLandmarks(projectId, landmarks) {
    return await ProjectRepository.saveLandmarks(projectId, landmarks);
  }

  async saveLayoutEntities(projectId, layoutEntities) {
    return await ProjectRepository.saveLayoutEntities(projectId, layoutEntities);
  }
}

module.exports = new ProjectService();
