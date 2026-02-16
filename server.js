require('dotenv').config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const projectRoutes = require("./routes/project.routes");
const publicRoutes = require("./routes/public.routes");
const trackingRoutes = require("./routes/tracking.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const organizationRoutes = require("./routes/organization.routes");
const userRoutes = require("./routes/user.routes");
const { initWebhookCron } = require("./services/WebhookCron");

const checkEnv = require("./utils/checkEnv");

// Validate environment before anything else
checkEnv();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/projects", projectRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/track", trackingRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/users", userRoutes);
app.use("/api/contacts", require("./routes/contact.routes"));


const PORT = process.env.PORT || 5001;

// Start server immediately (Cloud Run needs port open fast)
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});

// Connect to MongoDB in the background
connectDB().then(() => {
  // Initialize services that depend on DB
  initWebhookCron();
});
