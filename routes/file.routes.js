const express = require("express");
const crypto = require("crypto");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");

const { r2 } = require("../config/r2");
const Project = require("../models/Project");

const router = express.Router();

// ================= GET SIGNED URL =================
router.post("/get-upload-url", async (req, res) => {
  // example
  const project = await Project.findById(req.body.projectId);
  if (!project) return res.status(404).json({ error: "Not found" });

// optional: check user ownership
  try {
    const { fileName, fileType, projectId, type } = req.body;

    if (!fileName || !fileType || !projectId || !type) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "application/pdf"
    ];

    if (!allowedTypes.includes(fileType)) {
      return res.status(400).json({ error: "Invalid file type" });
    }

    const safeName = fileName.replace(/\s+/g, "-");
    const uniqueId = crypto.randomUUID();

    const fileKey = `projects/${projectId}/${type}/${uniqueId}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileKey,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(r2, command, {
      expiresIn: 300,
    });

console.log("Generated Upload URL:", uploadUrl);
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileKey}`;

    res.json({ uploadUrl, fileKey, fileUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate URL" });
  }
});

// ================= SAVE FILE =================
router.post("/save-file", async (req, res) => {
  try {
    const { projectId, type, file } = req.body;
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB (adjust)

    if (req.body.fileSize > MAX_SIZE) {
      return res.status(400).json({ error: "File too large" });
    }

    if (!projectId || !type || !file?.url || !file?.key) {
      return res.status(400).json({ error: "Invalid data" });
    }

    let update = {};

    if (type === "gallery") {
      update = { $push: { "media.galleryImages": file } };

    } else if (type === "video") {
      update = { $push: { "media.videos": file } };

    } else if (type === "brochure") {
      update = { $set: { "media.brochurePdf": file } };

    } else if (type === "cover") {
      update = { $set: { "media.coverImage": file } };

    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    const project = await Project.findByIdAndUpdate(projectId, update);

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Save failed" });
  }
});


router.delete("/delete-file", async (req, res) => {
  try {
    const { projectId, type, key } = req.body;

    if (!projectId || !type || !key) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 1. Delete from R2
    await r2.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));

    // 2. Remove from DB
    let update = {};

    if (type === "gallery") {
      update = { $pull: { "media.galleryImages": { key } } };

    } else if (type === "video") {
      update = { $pull: { "media.videos": { key } } };

    } else if (type === "brochure") {
      update = { $unset: { "media.brochurePdf": "" } };

    } else if (type === "cover") {
      update = { $unset: { "media.coverImage": "" } };

    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    await Project.findByIdAndUpdate(projectId, update);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  }
});

router.put("/replace-file", async (req, res) => {
  try {
    const { projectId, type, oldKey, newFile } = req.body;

    if (!projectId || !type || !oldKey || !newFile?.key) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 1. Delete old file
    await r2.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: oldKey,
    }));

    // 2. Update DB
    let update = {};

    if (type === "cover") {
      update = { $set: { "media.coverImage": newFile } };

    } else if (type === "brochure") {
      update = { $set: { "media.brochurePdf": newFile } };

    }

    await Project.findByIdAndUpdate(projectId, update);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Replace failed" });
  }
});
module.exports = router;