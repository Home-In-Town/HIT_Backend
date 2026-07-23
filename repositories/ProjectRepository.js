const Project = require('../models/Project');
const { v4: uuidv4 } = require('uuid');
const slugify = require('../utils/slugify');

function mapProject(project) {
  if (!project) return project;
  const { _id, ...rest } = project;
  return {
    id: _id.toString(),
    ...rest,
  };
}

class ProjectRepository {
  async getAll() {
    const projects = await Project.find()
      .populate('owner', 'name role companyName phone')
      .populate('assignedAgent', 'name phone')
      .lean();
    return projects.map(mapProject);
  }

  async getById(id) {
    const project = await Project.findById(id)
      .populate('owner', 'name role companyName phone')
      .populate('assignedAgent', 'name phone')
      .lean();
    return mapProject(project);
  }

  /**
   * Get projects by owner ID (for builder/agent role)
   */
  async getByOwner(ownerId) {
    const projects = await Project.find({ owner: ownerId })
      .populate('owner', 'name role companyName phone')
      .populate('assignedAgent', 'name phone')
      .lean();
    return projects.map(mapProject);
  }

  /**
   * Get projects assigned to an agent (employee)
   */
  async getByAssignedAgent(agentId) {
    const projects = await Project.find({ assignedAgent: agentId })
      .populate('owner', 'name role companyName phone')
      .populate('assignedAgent', 'name phone')
      .lean();
    return projects.map(mapProject);
  }

  /**
   * Get projects by array of IDs (for agent role)
   */
  async getByIds(projectIds) {
    if (!projectIds || projectIds.length === 0) return [];
    const projects = await Project.find({ _id: { $in: projectIds } }).populate('owner', 'name role companyName phone').lean();
    return projects.map(mapProject);
  }

  async create(projectData) {
    const project = new Project(projectData);
    await project.save();
    return mapProject(project.toObject());
  }

  async update(id, updates) {
    // Helper to flatten nested objects for partial updates ($set)
    const flatten = (obj, prefix = '') => {
      let result = {};
      for (const key in obj) {
        const val = obj[key];
        const newKey = prefix ? `${prefix}.${key}` : key;

        // Don't flatten arrays or special MongoDB types
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
          Object.assign(result, flatten(val, newKey));
        } else {
          result[newKey] = val;
        }
      }
      return result;
    };

    const flattenedUpdates = flatten(updates);

    const project = await Project.findByIdAndUpdate(
      id,
      { $set: { ...flattenedUpdates, updatedAt: new Date() } },
      { new: true }
    ).lean();
    return mapProject(project);
  }

  async delete(id) {
    const result = await Project.findByIdAndDelete(id);
    if (!result) return false;

    // Also clean up associated analytics data
    const Visit = require('../models/Visit');
    const CtaClick = require('../models/CtaClick');
    await Visit.deleteMany({ projectId: id });
    await CtaClick.deleteMany({ projectId: id });
    return true;
  }

  async publish(id, slug) {
    const project = await Project.findByIdAndUpdate(
      id,
      { slug, status: 'published', updatedAt: new Date() },
      { new: true }
    ).lean();
    return project;
  }

  async getBySlug(slug) {
    const project = await Project.findOne({ slug }).lean();
    return mapProject(project);
  }
  async getPublished() {
    const projects = await Project.find({ status: 'published' })
      .populate('owner', 'name role companyName phone')
      .populate('assignedAgent', 'name phone')
      .lean();
    return projects.map(mapProject);
  }
  // Save or update landmarks for a project
  async saveLandmarks(projectId, landmarks) {
    const project = await Project.findByIdAndUpdate(
      projectId,
      { landmarks, updatedAt: new Date() },
      { new: true }
    ).lean();
    return project ? project.landmarks : [];
  }

  // Save or update layout entities for a project
  async saveLayoutEntities(projectId, layoutEntities) {
    const project = await Project.findByIdAndUpdate(
      projectId,
      { layoutEntities, updatedAt: new Date() },
      { new: true }
    ).lean();
    return project ? project.layoutEntities : [];
  }
}

module.exports = new ProjectRepository();
