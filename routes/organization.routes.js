const express = require("express");
const router = express.Router();
const Organization = require("../models/Organization");
const mongoose = require("mongoose");
const { protect } = require("../middleware/auth");

router.use(protect);
// ---------------------------------------
// SAFE ID
// ---------------------------------------
function safeId(value) {
  if (!value) return null;
  try {
    if (typeof value === "string") return value;
    if (value._id) return String(value._id);
    return String(value);
  } catch {
    return null;
  }
}

// ---------------------------------------
// ACCESS HELPERS
// ---------------------------------------
function isOwner(org, user) {
  return safeId(org.createdBy) === String(user.id);
}

function isAssigned(org, user) {
  return (
    Array.isArray(org.agents) &&
    org.agents.some(a => safeId(a) === String(user.id))
  );
}

function canView(org, user) {
  if (!user) return false;

  if (user.role === "admin") return true;

  if (user.role === "builder") {
    return isOwner(org, user);
  }

  if (user.role === "agent") {
    return isOwner(org, user) || isAssigned(org, user);
  }

  return false;
}

function canModify(org, user) {
  if (!user) return false;

  if (user.role === "admin") return true;

  if (user.role === "builder") {
    return isOwner(org, user);
  }

  if (user.role === "agent") {
    return isOwner(org, user) || isAssigned(org, user);
  }

  return false;
}



// =======================================
// GET — ALL / ASSIGNED / CREATED
// =======================================
router.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Auth required" });

    let query = {};

    if (user.role === "admin") {
      query = {};
    }

    else if (user.role === "builder") {
      query = { createdBy: user.id };
    }

    else if (user.role === "agent") {
      const type = req.query.type; // all | assigned | created

      if (type === "created") {
        query = { createdBy: user.id };
      }

      else if (type === "assigned") {
        query = {
          agents: user.id,
          createdBy: { $ne: user.id } // exclude self-created
        };
      }

      else {
        // default = all visible
        query = {
          $or: [
            { createdBy: user.id },
            { agents: user.id }
          ]
        };
      }
    }


    else {
      return res.status(403).json({ error: "Not allowed" });
    }

    const orgs = await Organization.find(query)
      .populate("agents", "name email role")
      .populate("projects", `
      projectName 
      projectStatus 
      projectType 
      location 
      city 
      slug 
      status 
      pricing.startingPrice
    `)
      .lean();

    const cleaned = orgs
      .filter(o => safeId(o._id))
      .map(o => ({
        id: safeId(o._id),
        name: o.name,
        description: o.description,
        agents: o.agents || [],
        projects: o.projects || [],
        createdBy: safeId(o.createdBy)
      }));

    res.json(cleaned);

  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
});


// =======================================
// CREATE — ADMIN + AGENT + BUILDER
// =======================================
router.post("/", async (req, res) => {
  try {
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!["admin", "builder", "agent"].includes(user.role)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Organization name required" });
    }

    const normalized = name.trim();

    const exists = await Organization.findOne({
      name: { $regex: `^${normalized}$`, $options: "i" }
    });

    if (exists) {
      return res.status(400).json({ error: "Organization already exists" });
    }

    let agents = Array.isArray(req.body.agents)
      ? req.body.agents.filter(Boolean)
      : [];

    const projects = Array.isArray(req.body.projects)
      ? req.body.projects.filter(Boolean)
      : [];

    // 🟩 Agent auto-add self
    if (user.role === "agent") {
      if (!agents.includes(user.id)) {
        agents.push(user.id);
      }
    }

    const org = await Organization.create({
      name: normalized,
      description: description?.trim() || "",
      agents: agents.map(id => new mongoose.Types.ObjectId(id)),
      projects: projects.map(id => new mongoose.Types.ObjectId(id)),
      createdBy: new mongoose.Types.ObjectId(user.id)
    });

    const createdOrg = await Organization.findById(org._id)
      .populate("agents", "name email role")
      .populate("projects", `
        projectName 
        projectStatus 
        projectType 
        location 
        city 
        slug 
        status 
        pricing.startingPrice
      `)
      .lean();

    res.status(201).json({
      id: safeId(createdOrg._id),
      name: createdOrg.name,
      description: createdOrg.description,
      agents: createdOrg.agents || [],
      projects: createdOrg.projects || [],
      createdBy: safeId(createdOrg.createdBy)
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
});


// ========================================================
// UPDATE — ADMIN / BUILDER(OWNER) / AGENT(ASSIGNED+OWNER)
// ========================================================
router.put("/:id", async (req, res) => {
  try {
    const user = req.user;
    const org = await Organization.findById(req.params.id);

    if (!org) return res.status(404).json({ error: "Not found" });

    if (!canModify(org, user)) {
      return res.status(403).json({ error: "No permission" });
    }

    if (req.body.name) org.name = req.body.name.trim();
    if (req.body.description) org.description = req.body.description.trim();

    if (Array.isArray(req.body.agents)) {
      org.agents = req.body.agents
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));
    }

    if (Array.isArray(req.body.projects)) {
      org.projects = req.body.projects
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));
    }

    await org.save();

    const updatedOrg = await Organization.findById(org._id)
      .populate("agents", "name email role")
      .populate("projects", `
        projectName 
        projectStatus 
        projectType 
        location 
        city 
        slug 
        status 
        pricing.startingPrice
      `)
      .lean();

    res.json({
      id: safeId(updatedOrg._id),
      name: updatedOrg.name,
      description: updatedOrg.description,
      agents: updatedOrg.agents || [],
      projects: updatedOrg.projects || [],
      createdBy: safeId(updatedOrg.createdBy)
    });

  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
});


// =========================================================
// DELETE — ADMIN / BUILDER(OWNER) / AGENT(ASSIGNED+OWNER)
// =========================================================
router.delete("/:id", async (req, res) => {
  try {
    const user = req.user;
    const org = await Organization.findById(req.params.id);

    if (!org) return res.status(404).json({ error: "Not found" });

    if (!canModify(org, user)) {
      return res.status(403).json({ error: "No permission" });
    }

    await org.deleteOne();

    res.status(204).send();

  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

module.exports = router;