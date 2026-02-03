const CallLog = require('../models/CallLog');

class CallRepository {
  async getAll() {
    return await CallLog.find().sort({ createdAt: -1 }).lean();
  }

  async getByProject(projectId) {
    if (!projectId) return [];
    return await CallLog.find({ projectId }).sort({ createdAt: -1 }).lean();
  }

  async getById(callId) {
    return await CallLog.findOne({ callId }).lean();
  }

  async getByPhoneNumber(phoneNumber) {
    if (!phoneNumber) return [];
    // Search in toNumber OR fromNumber
    return await CallLog.find({
      $or: [
        { toNumber: phoneNumber },
        { fromNumber: phoneNumber }
      ]
    }).sort({ createdAt: -1 }).lean();
  }
}

module.exports = new CallRepository();
