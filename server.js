require('dotenv').config();
// Force Node.js to use Google DNS for SRV lookups (fixes local router DNS issues)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');


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
const chatRoutes = require('./routes/chat.routes');
const crmRoutes = require('./routes/crm.routes');
const marketplaceRoutes = require('./routes/marketplace.routes');
const notificationRoutes = require('./routes/notification.routes');
const groupChatRoutes = require('./routes/groupChat.routes');
const shareRoutes = require('./routes/share.routes');

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
  'https://www.homeintown.ai',   // Public map site (Hostinger) — was missing, causing 500 on CORS
  'https://homeintown.ai',       // Public map site (no-www)
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

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// ============ RATE LIMITING PRE-EXTRACTION ============
// Extract JWT before rate limiter to enable User-ID based limiting
app.use((req, res, next) => {
  const token = req.cookies?.token || req.headers?.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded && decoded.id) {
        req.userId = decoded.id;
      }
    } catch (err) {
      // Silently ignore JWT errors - rate limiter will fallback to IP-based limiting
    }
  }
  next();
});

app.use(generalLimiter);



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
app.use('/api/chat', chatRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/crm-bridge', require('./routes/crmBridge.routes'));
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/group-chat', groupChatRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/lead-matching', require('./routes/leadMatching.routes'));

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

    // Create HTTP server and attach Socket.io
    const server = http.createServer(app);
    const io = new Server(server, {
      cors: {
        origin: ALLOWED_ORIGINS,
        credentials: true,
        methods: ['GET', 'POST']
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // Store io instance on app for use in controllers
    app.set('io', io);

    // Initialize chat socket handlers
    require('./sockets/chat.socket')(io);
    require('./sockets/groupChat.socket')(io);
    logger.info('Socket.io chat engine initialized (1:1 + group)');

    // Start listening
    server.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info('WebSocket server ready for connections');
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
