const express = require("express");
const router = express.Router();
const upload = require("../middleware/uploadBrochure");

router.post("/brochure", upload.single("brochure"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const fileUrl = `/uploads/brochures/${req.file.filename}`;

    res.status(200).json({ url: fileUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;