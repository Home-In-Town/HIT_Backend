/**
 * Structured Logger
 * Replaces console.log with timestamped, leveled logging
 */

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
};

class Logger {
  constructor(module) {
    this.module = module;
    this.logLevel = process.env.LOG_LEVEL || 'DEBUG';
  }

  _log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.module}]`;
    
    const logEntry = {
      timestamp,
      level,
      module: this.module,
      message,
      ...(data && { data }),
    };

    const output = data 
      ? `${prefix} ${message} ${JSON.stringify(data)}` 
      : `${prefix} ${message}`;

    if (level === LOG_LEVELS.ERROR) {
      console.error(output);
    } else if (level === LOG_LEVELS.WARN) {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  error(message, data = null) {
    this._log(LOG_LEVELS.ERROR, message, data);
  }

  warn(message, data = null) {
    this._log(LOG_LEVELS.WARN, message, data);
  }

  info(message, data = null) {
    this._log(LOG_LEVELS.INFO, message, data);
  }

  debug(message, data = null) {
    this._log(LOG_LEVELS.DEBUG, message, data);
  }
}

module.exports = Logger;
