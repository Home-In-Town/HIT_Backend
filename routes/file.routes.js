const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");

const { r2 } = require("../config/r2");
const Project = require("../models/Project");

const router = express.Router();

// Multer: keep files in memory (max 50MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ================= PROXY UPLOAD (NO CORS ISSUE) =================
router.post("/proxy-upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const projectId = req.body?.projectId;
    const type = req.body?.type;

    if (!file || !projectId || !type) {
      return res.status(400).json({
        error: "Missing file, projectId, or type",
        received: { hasFile: !!file, projectId, type }
      });
    }

    const allowedTypes = [
      "image/jpeg", "image/png", "image/webp",
      "video/mp4", "video/webm",
      "application/pdf"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: "Invalid file type" });
    }

    // Check project exists
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const safeName = file.originalname.replace(/\s+/g, "-");
    const uniqueId = crypto.randomUUID();
    const fileKey = `projects/${projectId}/${type}/${uniqueId}-${safeName}`;

    const bucketName = process.env.R2_BUCKET_NAME;
    console.log(`📤 Proxy upload: bucket="${bucketName}", key="${fileKey}", size=${file.size}`);

    // Upload to R2 server-side (no CORS needed)
    await r2.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileKey}`;

    // Save to DB
    const fileData = { url: fileUrl, key: fileKey };
    let update = {};

    if (type === "cover") {
      update = { $set: { "media.coverImage": fileData } };
    }else if (type === "layout") {
      update = { $set: { "media.layoutImage": fileData } };
    }else if (type === "gallery") {
      update = { $push: { "media.galleryImages": fileData } };
    } else if (type === "video") {
      update = { $push: { "media.videos": fileData } };
    } else if (type === "brochure") {
      update = { $set: { "media.brochurePdf": fileData } };
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    await Project.findByIdAndUpdate(projectId, update);

    console.log(`✅ Proxy upload success: ${fileKey}`);
    res.json({ fileUrl, fileKey });

  } catch (err) {
    console.error("❌ Proxy upload error:", err.Code || err.message, err);
    res.status(500).json({ error: "Upload failed", detail: err.Code || err.message });
  }
});

// ================= LOGO UPLOAD (no projectId required) =================
router.post("/upload-logo", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: "Logo must be JPEG, PNG, or WebP" });
    }

    if (file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Logo must be 5 MB or smaller" });
    }

    const safeName = file.originalname.replace(/\s+/g, "-");
    const uniqueId = crypto.randomUUID();
    const fileKey = `logos/${uniqueId}-${safeName}`;

    const bucketName = process.env.R2_BUCKET_NAME;
    console.log(`📤 Logo upload: bucket="${bucketName}", key="${fileKey}", size=${file.size}`);

    await r2.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileKey}`;

    console.log(`✅ Logo upload success: ${fileKey}`);
    res.json({ fileUrl, fileKey });

  } catch (err) {
    console.error("❌ Logo upload error:", err.message, err);
    res.status(500).json({ error: "Logo upload failed", detail: err.message });
  }
});

// ================= GET SIGNED URL (kept as fallback) =================
router.post("/get-upload-url", async (req, res) => {
  const project = await Project.findById(req.body.projectId);
  if (!project) return res.status(404).json({ error: "Not found" });

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
      unhoistableHeaders: new Set([
        "x-amz-sdk-checksum-algorithm",
        "x-amz-checksum-crc32"
      ]),
      signableHeaders: new Set(["content-type"])
    });

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

    }else if (type === "layout") {
      update = { $set: { "media.layoutImage": file } };
    }else if (type === "video") {
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

    }else if (type === "layout") {
      update = { $unset: { "media.layoutImage": "" } };
    }else {
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