const mongoose = require('mongoose');
const Logger = require('../utils/logger');

const logger = new Logger('Database');

const DB_CONFIG = {
  dbName: 'salesdb', // Hardcoded database name from original file
  serverSelectionTimeoutMS: 10000, // Increased for stability
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 5,
  retryWrites: true,
};

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

const connectDB = async (retryCount = 0) => {
  try {
    const uri = process.env.MONGODB_CONNECTION_URL;
    if (!uri) {
      throw new Error('MONGODB_CONNECTION_URL is missing in environment variables');
    }

    const maskedUri = uri.replace(/:([^:@]+)@/, ':****@');
    logger.info(`Connecting to MongoDB (Attempt ${retryCount + 1}/${MAX_RETRIES + 1})`, { uri: maskedUri });

    const conn = await mongoose.connect(uri, DB_CONFIG);
    logger.info('MongoDB Connected Successfully', { host: conn.connection.host });

    // Setup connection event listeners
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected unexpectedly');
    });

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error', { error: err.message });
    });

    return true;
  } catch (error) {
    logger.error(`MongoDB Connection Error (Attempt ${retryCount + 1})`, { 
      error: error.message,
      code: error.code 
    });

    if (retryCount < MAX_RETRIES) {
      logger.info(`Retrying in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectDB(retryCount + 1);
    }

    // All retries exhausted - exit gracefully
    logger.error('Failed to connect to MongoDB after all retries. Exiting process.');
    process.exit(1);
  }
};

/**
 * Graceful shutdown for MongoDB connection
 */
const gracefulShutdown = async () => {
  logger.info('Initiating graceful shutdown for MongoDB...');
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error during MongoDB shutdown', { error: error.message });
  }
};

module.exports = { connectDB, gracefulShutdown };
