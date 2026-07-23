const ProjectRepository = require('../repositories/ProjectRepository');
const slugify = require('../utils/slugify');
const User = require('../models/User');
const Notification = require('../models/Notification');

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

  /**
   * Get projects assigned to an agent (employee)
   */
  async getProjectsAssignedToAgent(agentId) {
    return await ProjectRepository.getByAssignedAgent(agentId);
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

  async assignAgentToProject(projectId, agentId, captainId) {
    // 1. Fetch existing project
    const project = await ProjectRepository.getById(projectId);
    if (!project) throw new Error('Project not found');

    // 2. Verify the captain actually owns this project
    const ownerId = project.owner ? (typeof project.owner === 'object' ? project.owner._id?.toString() : project.owner.toString()) : null;
    if (ownerId !== captainId) {
      throw new Error('Not authorized');
    }

    // 3. If agentId is not null, validate it's a confirmed employee under this captain
    if (agentId !== null) {
      const agent = await User.findById(agentId).lean();
      if (!agent || agent.role !== 'employee') {
        throw new Error('Invalid agent');
      }
      if (!agent.employerId || agent.employerId.toString() !== captainId) {
        throw new Error('Agent not under your team');
      }
      if (!agent.isEmployerConfirmed) {
        throw new Error('Agent not under your team');
      }
    }

    // 4. Check for no-op (idempotent)
    const previousAgentId = project.assignedAgent ? (typeof project.assignedAgent === 'object' ? project.assignedAgent._id?.toString() : project.assignedAgent.toString()) : null;
    const newAgentId = agentId ? agentId.toString() : null;

    if (previousAgentId === newAgentId) {
      return project;
    }

    // 5. Update assignedAgent field
    const updatedProject = await ProjectRepository.update(projectId, { assignedAgent: agentId });

    // 6. Send notifications (fire-and-forget)
    try {
      const projectName = updatedProject.projectName || 'Unnamed Project';

      // Notify new agent (if assigning)
      if (agentId) {
        await Notification.create({
          recipient: agentId,
          type: 'system',
          title: 'Project Assigned',
          message: `You have been assigned to project: ${projectName}`,
          reference: { model: 'Project', id: projectId }
        });
      }

      // Notify old agent (if one existed)
      if (previousAgentId) {
        await Notification.create({
          recipient: previousAgentId,
          type: 'system',
          title: 'Project Unassigned',
          message: `You have been removed from project: ${projectName}`,
          reference: { model: 'Project', id: projectId }
        });
      }
    } catch (notifError) {
      console.error('Failed to create agent assignment notification:', notifError);
    }

    return updatedProject;
  }

  async assignCaptainToProject(projectId, captainId) {
    // 1. Fetch existing project
    const project = await ProjectRepository.getById(projectId);
    if (!project) throw new Error('Project not found');

    // 2. If captainId is not null, validate it's a real captain
    if (captainId !== null) {
      const captain = await User.findById(captainId).lean();
      if (!captain || captain.role !== 'captain') {
        throw new Error('Invalid captain');
      }
    }

    // 3. Capture previous owner before update
    const previousOwnerId = project.owner ? (typeof project.owner === 'object' ? project.owner._id?.toString() : project.owner.toString()) : null;
    const newOwnerId = captainId ? captainId.toString() : null;

    // 4. If no change, return project as-is (idempotent for null→null)
    if (previousOwnerId === newOwnerId) {
      return project;
    }

    // 5. Update owner field
    const updatedProject = await ProjectRepository.update(projectId, { owner: captainId });

    // 6. Send notifications (fire-and-forget, errors logged not thrown)
    try {
      const projectName = updatedProject.projectName || 'Unnamed Project';

      // Notify new captain (if assigning, not unassigning)
      if (captainId) {
        await Notification.create({
          recipient: captainId,
          type: 'system',
          title: 'Project Assigned',
          message: `You have been assigned to project: ${projectName}`,
          reference: { model: 'Project', id: projectId }
        });
      }

      // Notify old captain (if one existed)
      if (previousOwnerId) {
        await Notification.create({
          recipient: previousOwnerId,
          type: 'system',
          title: 'Project Unassigned',
          message: `You have been removed from project: ${projectName}`,
          reference: { model: 'Project', id: projectId }
        });
      }
    } catch (notifError) {
      console.error('Failed to create assignment notification:', notifError);
    }

    return updatedProject;
  }
}

module.exports = new ProjectService();
