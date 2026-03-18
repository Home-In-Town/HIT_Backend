const Logger = require('../utils/logger');

const logger = new Logger('ErrorHandler');

class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
    this.name = 'AppError';
  }
}

/**
 * Global error handler middleware
 * Must be last middleware in app.use() chain
 */
const errorHandler = (err, req, res, next) => {
  // Set default error properties
  err.status = err.status || 500;
  err.message = err.message || 'Internal Server Error';

  // Log error with context
  logger.error('Request Error', {
    method: req.method,
    url: req.url,
    status: err.status,
    message: err.message,
    userId: req.user?.id || 'anonymous',
  });

  // Handle specific error types
  if (err.name === 'ValidationError') {
    err.status = 400;
    err.message = 'Validation failed';
  }

  if (err.name === 'CastError') {
    err.status = 400;
    err.message = 'Invalid ID format';
  }

  if (err.name === 'JsonWebTokenError') {
    err.status = 401;
    err.message = 'Invalid token';
  }

  if (err.name === 'TokenExpiredError') {
    err.status = 401;
    err.message = 'Token expired';
  }

  // MongoDB duplicate key error (code 11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    err.status = 409;
    err.message = `${field} already exists`;
  }

  const isProd = process.env.NODE_ENV === 'production';

  res.status(err.status).json({
    error: isProd && err.status === 500 ? 'Internal Server Error' : err.message,
    status: err.status,
    // Only include stack trace in development
    ...(!isProd && { 
      stack: err.stack,
      details: err.details || null,
    }),
  });
};

/**
 * Async handler wrapper
 * Catches errors in async route handlers and passes to error handler
 * Usage: router.post('/route', catchAsync(asyncController))
 */
const catchAsync = (fn) => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};

module.exports = {
  errorHandler,
  catchAsync,
  AppError,
};
