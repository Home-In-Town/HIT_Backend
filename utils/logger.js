/**
 * Structured Logger
 * Replaces console.log with timestamped, leveled logging with PII masking
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

  /**
   * PII Masking Helpers
   */
  _maskPhone(phone) {
    if (!phone) return '****';
    const s = String(phone);
    if (s.length < 4) return '****';
    return s.slice(0, 3) + '****' + s.slice(-2);
  }

  _maskName(name) {
    if (!name) return '****';
    const s = String(name);
    if (s.length < 2) return '****';
    return s.slice(0, 2) + '****';
  }

  _maskId(id) {
    if (!id) return '****';
    const s = String(id);
    if (s.length < 8) return '****';
    return s.slice(0, 4) + '****' + s.slice(-4);
  }

  _maskEmail(email) {
    if (!email) return '****';
    const s = String(email);
    const parts = s.split('@');
    if (parts.length !== 2) return '****';
    const [user, domain] = parts;
    if (user.length < 2) return '*@' + domain;
    return user.slice(0, 2) + '****@' + domain;
  }

  /**
   * Structured Data Masking
   */
  _maskData(data) {
    if (!data || typeof data !== 'object') return data;
    
    // Deep clone to avoid mutating original object
    const masked = JSON.parse(JSON.stringify(data));
    
    const sensitiveKeys = [
      'phone', 'phoneNumber', 'ownerPhone', 'customerPhone', 
      'name', 'fullName', 'userId', 'salesProfileId', 'socketId',
      'email', 'mpin', 'password', 'token', 'accessToken', 'refreshToken',
      'secret', 'apiKey', 'clientSecret'
    ];
    
    const maskValue = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      
      Object.keys(obj).forEach(key => {
        const lowerKey = key.toLowerCase();
        
        if (sensitiveKeys.some(sk => lowerKey.includes(sk.toLowerCase()))) {
          const val = obj[key];
          if (typeof val === 'string' || typeof val === 'number') {
            if (lowerKey.includes('phone')) obj[key] = this._maskPhone(val);
            else if (lowerKey.includes('email')) obj[key] = this._maskEmail(val);
            else if (lowerKey.includes('id') || lowerKey.includes('socket')) obj[key] = this._maskId(val);
            else if (lowerKey.includes('name')) obj[key] = this._maskName(val);
            else obj[key] = '[REDACTED]';
          } else if (val && typeof val === 'object') {
            obj[key] = '[REDACTED OBJECT]';
          }
        } else if (obj[key] && typeof obj[key] === 'object') {
          maskValue(obj[key]);
        }
      });
    };

    maskValue(masked);
    return masked;
  }

  _log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.module}]`;
    
    const maskedData = data ? this._maskData(data) : null;

    const output = maskedData 
      ? `${prefix} ${message} ${JSON.stringify(maskedData)}` 
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

