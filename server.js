require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const Logger = require('./utils/logger');
const { connectDB, gracefulShutdown } = require('./config/db');
const { errorHandler } = require('./middleware/errorHandler');
const checkEnv = require('./utils/checkEnv');

// Initialize logger
const logger = new Logger('Server');

// Import routes
const projectRoutes = require('./routes/project.routes');
const publicRoutes = require('./routes/public.routes');
const trackingRoutes = require('./routes/tracking.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const organizationRoutes = require('./routes/organization.routes');
const userRoutes = require('./routes/user.routes');
const employeeRoutes = require('./routes/employee.routes');
const authRoutes = require('./routes/auth.routes');
const contactRoutes = require('./routes/contact.routes');
const fileRoutes = require('./routes/file.routes');
const internalRoutes = require('./routes/internalRoutes');

// Import services
const { initWebhookCron } = require('./services/WebhookCron');

// Import middleware
const { generalLimiter } = require('./middleware/rateLimiter');

// Validate environment first
checkEnv();

const app = express();
const PORT = process.env.PORT || 5001;

// ============ SECURITY MIDDLEWARE ============

// CORS Configuration
const ALLOWED_ORIGINS = [
  'https://www.homeintown.in',
  'https://homeintown.in',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(o => o.trim()) : []),
];

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Enable CSP with common safe policies
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn('CORS rejected', { origin });
        callback(new Error(`CORS blocked: origin '${origin}' not allowed`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'x-sso-token',
    ],
    exposedHeaders: ['set-cookie'],
  })
);

app.use(generalLimiter);
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// ============ ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employee', employeeRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/internal', internalRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler (MUST be last)
app.use(errorHandler);

// ============ SERVER STARTUP ============

const startServer = async () => {
  try {
    logger.info('Starting server initialization...');

    // Connect to MongoDB
    await connectDB();

    // Initialize services that depend on DB
    try {
      initWebhookCron();
      logger.info('Webhook cron service initialized');
    } catch (cronError) {
      logger.warn('Failed to initialize webhook cron (non-critical)', {
        error: cronError.message,
      });
    }

    // Start listening
    const server = app.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // Handle graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, shutting down gracefully...`);
      
      // Force exit after 10 seconds if graceful shutdown hangs
      setTimeout(() => {
        logger.error('Graceful shutdown timed out, forcing exit.');
        process.exit(1);
      }, 10000).unref();

      try {
        if (server) {
          await new Promise((resolve) => {
            server.close((err) => {
              if (err) {
                logger.error('Error closing server', { error: err.message });
              }
              resolve();
            });
          });
        }
        
        await gracefulShutdown();
        logger.info('Cleanup complete. Exiting.');
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', { error: err.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception - forcing exit', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', { reason });
  process.exit(1);
});

// Start the server
startServer();
