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
    const projects = await Project.find().lean();
    return projects.map(mapProject);
  }

  async getById(id) {
    const project = await Project.findById(id).lean();
    return mapProject(project);
  }

  async create(projectData) {
    const project = new Project(projectData);
    await project.save();
    return mapProject(project.toObject());
  }

  async update(id, updates) {
    const project = await Project.findByIdAndUpdate(
    id,
    { ...updates, updatedAt: new Date() },
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
}

module.exports = new ProjectRepository();
