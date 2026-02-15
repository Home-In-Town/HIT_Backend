const axios = require('axios');
const config = require('../config');
const CallLog = require('../models/CallLog');

class VoiceService {
  async getCallStatus(callId) {
    try {
      const response = await axios.get(`${config.VOICE_API_BASE_URL}/calls/status/${callId}`);
      const callData = response.data;
      
      // Update local CallLog with latest data from Voice API
      await this.updateCallLog(callId, callData);
      
      return callData;
    } catch (error) {
      this.handleError(error);
    }
  }

  async initiateCall(payload) {
    try {
      const url = `${config.VOICE_API_BASE_URL}/calls/new`;
      // Ensure strict mapping of required fields
      const apiPayload = {
        to: payload.to,
        from: payload.from,
        clientId: payload.clientId,
        agentId: payload.agentId,
        url: payload.url // Optional
      };

      console.log(`📡 Sending Voice Request to: ${url}`);
      console.log('📦 Payload:', JSON.stringify(apiPayload, null, 2));

      const response = await axios.post(url, apiPayload);
      const result = response.data;
      
      // Create a local CallLog record
      await this.createCallLog(result, apiPayload);
      
      return result;
    } catch (error) {
      if (error.response) {
        console.error("❌ Upstream Error Status:", error.response.status);
        console.error("❌ Upstream Error Data:", JSON.stringify(error.response.data, null, 2));
      }
      this.handleError(error);
    }
  }

  async createCallLog(apiResponse, originalPayload) {
    try {
      const dbCall = apiResponse.dbCall || apiResponse;
      
      const callLog = new CallLog({
        callId: dbCall.callId || dbCall.id,
        externalCallId: dbCall.callId,
        projectId: originalPayload.projectId || null,
        agentId: dbCall.agentId || originalPayload.agentId,
        clientId: dbCall.clientId || originalPayload.clientId,
        toNumber: dbCall.userNumber || dbCall.toNumber || originalPayload.to,
        fromNumber: dbCall.aiNumber || dbCall.fromNumber || originalPayload.from,
        status: dbCall.status || 'initiated',
        startTime: dbCall.startTime || new Date()
      });

      await callLog.save();
      console.log(`📞 CallLog created: ${callLog.callId}`);
      return callLog;
    } catch (error) {
      console.error('Failed to create CallLog:', error.message);
      // Don't throw - we don't want logging failure to break the call
    }
  }

  async updateCallLog(callId, callData) {
    try {
      await CallLog.findOneAndUpdate(
        { callId: callId },
        {
          status: callData.status,
          endTime: callData.endTime,
          duration: callData.duration,
          transcript: callData.transcript,
          callSummary: callData.callSummary,
          userAnalyticsSummary: callData.userAnalyticsSummary,
          agentAnalyticsSummary: callData.agentAnalyticsSummary,
          conversationData: callData.conversationData,
          recordingLink: callData.recordingLink
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      console.error('Failed to update CallLog:', error.message);
    }
  }

  handleError(error) {
    if (error.response) {
      const e = new Error(error.response.data.message || 'Upstream API Error');
      e.statusCode = error.response.status;
      e.data = error.response.data;
      throw e;
    } else if (error.request) {
      const e = new Error('Service Unavailable: No response from Voice API');
      e.statusCode = 503;
      throw e;
    } else {
      throw error;
    }
  }
}

module.exports = new VoiceService();
