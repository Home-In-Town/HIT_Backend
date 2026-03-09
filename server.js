require('dotenv').config();
const express = require("express");
const helmet = require('helmet');
const cors = require("cors");
const connectDB = require("./config/db");

const projectRoutes = require("./routes/project.routes");
const publicRoutes = require("./routes/public.routes");
const trackingRoutes = require("./routes/tracking.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const organizationRoutes = require("./routes/organization.routes");
const userRoutes = require("./routes/user.routes");
const { initWebhookCron } = require("./services/WebhookCron");

const cookieParser = require('cookie-parser');
const authRoutes = require("./routes/auth.routes");

const checkEnv = require("./utils/checkEnv");
const fileRoutes = require("./routes/file.routes");
const { generalLimiter } = require('./middleware/rateLimiter');

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

app.use(helmet());
app.use(generalLimiter);

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


app.use(cookieParser());

app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/track", trackingRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/users", userRoutes);
app.use("/api/contacts", require("./routes/contact.routes"));
app.use("/api/internal", require("./routes/internalRoutes"));

app.use("/api/files", fileRoutes);

// Global Error Handler (Must be last)
app.use(require('./middleware/errorHandler'));

const PORT = process.env.PORT || 5001;

const startServer = async () => {
  try {
    // Connect to MongoDB first
    await connectDB();

    // Initialize services that depend on DB
    initWebhookCron();

    // Start listening
    app.listen(PORT, () => {
      console.log(`🚀 Secured Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
};

startServer();
