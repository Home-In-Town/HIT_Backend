const VoiceService = require('../services/VoiceService');
const CallRepository = require('../repositories/CallRepository');

/**
 * Normalizes and validates the call payload
 * - Accepts projectId as alias for clientId
 * - Auto-formats phone numbers to E.164 (adds +91 for Indian numbers)
 * - Uses projectId as fallback for agentId if missing
 * @param {Object} body - Request body
 * @returns {{ valid: boolean, errors: string[], normalized: Object }}
 */
function validateAndNormalizePayload(body) {
  const errors = [];
  
  // Create normalized payload
  const normalized = { ...body };
  
  // Accept projectId as alias for clientId
  if (!normalized.clientId && normalized.projectId) {
    normalized.clientId = normalized.projectId;
  }
  
  // Use projectId or clientId as fallback for agentId
  if (!normalized.agentId) {
    normalized.agentId = normalized.projectId || normalized.clientId;
  }
  
  // Auto-format phone number to E.164 (Indian default)
  if (normalized.to) {
    let phone = normalized.to.toString().replace(/\D/g, '');
    // If it's an Indian number without country code, add +91
    if (phone.length === 10 && /^[6-9]/.test(phone)) {
      normalized.to = `+91${phone}`;
    } else if (!normalized.to.startsWith('+')) {
      // Assume +91 for any non-prefixed number
      normalized.to = `+${phone}`;
    }
  }
  
  // Validate required fields
  if (!normalized.to) {
    errors.push('"to" is required: Recipient phone number');
  } else if (!/^\+[1-9]\d{1,14}$/.test(normalized.to)) {
    errors.push('"to" must be in E.164 format (e.g., +919876543210)');
  }
  
  if (!normalized.clientId) {
    errors.push('"clientId" or "projectId" is required: MongoDB ObjectId of the client');
  }
  
  if (!normalized.agentId) {
    errors.push('"agentId" is required: Agent or phone configuration ID');
  }

  if (!normalized.from) {
    errors.push('"from" is required: Your Twilio phone number');
  }
  
  return { valid: errors.length === 0, errors, normalized };
}

class CallController {
  async getStatus(req, res) {
    try {
      const { callId } = req.params;
      const data = await VoiceService.getCallStatus(callId);
      res.json(data);
    } catch (error) {
      res.status(error.statusCode || 500).json(error.data || { message: error.message });
    }
  }

  async newCall(req, res) {
    try {
      console.log('📥 Incoming /api/calls/new', req.body);

      // Validate and normalize payload
      const validation = validateAndNormalizePayload(req.body);
      if (!validation.valid) {
        console.log('❌ Validation errors:', validation.errors);
        return res.status(400).json({
          message: 'Validation failed',
          errors: validation.errors
        });
      }

      console.log('✅ Normalized payload:', validation.normalized);
      const data = await VoiceService.initiateCall(validation.normalized);
      res.status(201).json(data);
    } catch (error) {
      console.error('❌ Voice API failed:', error.message);
      res.status(error.statusCode || 500).json(error.data || { message: error.message });
    }
  }

  async getLogs(req, res) {
    try {
      const logs = await CallRepository.getAll();
      res.json(logs);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getLogsByProject(req, res) {
    try {
      const { projectId } = req.params;
      const logs = await CallRepository.getByProject(projectId);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  async getLogsByNumber(req, res) {
    try {
      const { number } = req.params;
      const logs = await CallRepository.getByPhoneNumber(number);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new CallController();
