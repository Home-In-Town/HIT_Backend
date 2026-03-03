require('dotenv').config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const projectRoutes = require("./routes/project.routes");
const uploadRoutes = require("./routes/upload.routes");
const publicRoutes = require("./routes/public.routes");
const trackingRoutes = require("./routes/tracking.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const organizationRoutes = require("./routes/organization.routes");
const userRoutes = require("./routes/user.routes");
const { initWebhookCron } = require("./services/WebhookCron");

const cookieParser = require('cookie-parser');
const authRoutes = require("./routes/auth.routes");

const checkEnv = require("./utils/checkEnv");

// Validate environment before anything else
checkEnv();

const app = express();

// Other routes

// Allow credentials for JWT Cookies
const ALLOWED_ORIGINS = [
  'https://www.homeintown.in',
  'https://homeintown.in',
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(o => o.trim()) : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server requests (no origin) and whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: origin '${origin}' not allowed`));
    }
  },
  credentials: true
}));

//  FIRST → upload route (NO JSON PARSER)
app.use("/api/upload", uploadRoutes);

app.use(cookieParser());
//  THEN → JSON parser
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));


app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/track", trackingRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/users", userRoutes);
app.use("/api/contacts", require("./routes/contact.routes"));
app.use("/api/internal", require("./routes/internalRoutes"));

app.use("/api/uploads", express.static("uploads"));

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
