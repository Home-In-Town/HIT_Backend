const Joi = require('joi');

// Phone number validation - Indian format
const phoneSchema = Joi.string()
  .pattern(/^(?:\+91)?[6-9]\d{9}$/)
  .required()
  .messages({
    'string.pattern.base': 'Phone must be a valid Indian number (10 digits starting with 6-9, optionally prefixed with +91)',
    'any.required': 'Phone is required',
  });

// MPIN validation - 4-6 digits
const mpinSchema = Joi.string()
  .pattern(/^\d{4,6}$/)
  .required()
  .messages({
    'string.pattern.base': 'MPIN must be 4-6 digits',
    'any.required': 'MPIN is required',
  });

// OTP validation - 6 digits
const otpSchema = Joi.string()
  .pattern(/^\d{6}$/)
  .required()
  .messages({
    'string.pattern.base': 'OTP must be exactly 6 digits',
    'any.required': 'OTP is required',
  });

const authValidationSchemas = {
  register: Joi.object({
    name: Joi.string()
      .trim()
      .min(2)
      .max(50)
      .required()
      .messages({
        'string.min': 'Name must be at least 2 characters',
        'string.max': 'Name must not exceed 50 characters',
        'any.required': 'Name is required',
      }),
    phone: phoneSchema,
    mpin: mpinSchema,
    email: Joi.string()
      .email()
      .optional()
      .allow('')
      .messages({
        'string.email': 'Email must be valid',
      }),
    role: Joi.string()
      .valid('builder', 'agent', 'employee', 'user', 'captain')
      .optional()
      .default('user'),

    // Captain-specific fields (optional for all roles except companyName for captain)
    companyName: Joi.string()
      .trim()
      .min(2)
      .max(100)
      .when('role', { is: 'captain', then: Joi.required() })
      .optional()
      .messages({
        'string.min': 'Company name must be at least 2 characters',
        'string.max': 'Company name must not exceed 100 characters',
        'any.required': 'Company name is required for captain registration',
      }),
    businessAddress: Joi.string().trim().max(200).optional().allow(''),
    businessCity: Joi.string().trim().max(100).optional().allow(''),
    businessState: Joi.string().trim().max(100).optional().allow(''),
    businessPinCode: Joi.string()
      .pattern(/^\d{6}$/)
      .optional()
      .allow('')
      .messages({
        'string.pattern.base': 'Business PIN code must be exactly 6 digits',
      }),
    businessLogoUrl: Joi.string()
      .uri({ scheme: ['https'] })
      .optional()
      .allow('')
      .messages({
        'string.uri': 'Business logo URL must be a valid HTTPS URL',
      }),
  }),

  verifyOtp: Joi.object({
    phone: phoneSchema,
    code: otpSchema,
    type: Joi.string()
      .valid('register', 'reset')
      .optional()
      .default('register'),
  }),

  login: Joi.object({
    phone: phoneSchema,
    mpin: mpinSchema,
  }),

  forgotMpin: Joi.object({
    phone: phoneSchema,
  }),

  resetMpin: Joi.object({
    phone: phoneSchema,
    code: otpSchema,
    newMpin: mpinSchema,
  }),
};

/**
 * Validation middleware factory
 * Usage: router.post('/register', validate(authValidationSchemas.register), controller)
 */
const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true, // Remove unknown fields
    });

    // Normalize phone number if present after validation
    if (value && value.phone && typeof value.phone === 'string' && /^[6-9]\d{9}$/.test(value.phone)) {
        value.phone = `+91${value.phone}`;
    }

    if (error) {
      const details = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return res.status(400).json({
        error: 'Validation failed',
        details,
      });
    }

    // Replace req.body with validated/sanitized data
    req.body = value;
    next();
  };
};

module.exports = {
  authValidationSchemas,
  validate,
};
