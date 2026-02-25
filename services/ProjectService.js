const ProjectRepository = require('../repositories/ProjectRepository');
const Organization = require('../models/Organization');
const slugify = require('../utils/slugify');

class ProjectService {
  async getAllProjects() {
    return await ProjectRepository.getAll();
  }

  async getProjectById(id) {
    return await ProjectRepository.getById(id);
  }

  /**
   * Get projects created by a specific builder
   */
  async getProjectsByBuilder(builderId) {
    return await ProjectRepository.getByBuilderId(builderId);
  }

  /**
   * Get projects assigned to organizations that the agent belongs to
   */
  async getProjectsForAgent(agentId) {
    // Find all organizations where this agent is a member
    const orgs = await Organization.find({ agents: agentId }).select('projects');

   // Safely flatten project IDs
  const projectIds = orgs.flatMap(org => org.projects ?? []);

  // Remove null/undefined safely
  const uniqueProjectIds = [
    ...new Set(
      projectIds
        .filter(id => id) 
        .map(id => id.toString())
    )
  ];

  if (uniqueProjectIds.length === 0) {
    return []; //  Return empty array instead of null
  }


    return await ProjectRepository.getByIds(uniqueProjectIds);
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
}

module.exports = new ProjectService();

