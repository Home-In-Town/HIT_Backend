const twilio = require('twilio');

class TwilioService {
    constructor() {
        this._client = null;
        this.serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
        this.accSid = process.env.TWILIO_ACCOUNT_SID;
        this.authToken = process.env.TWILIO_AUTH_TOKEN;

        // Check if we are in mock mode (placeholders or missing SID)
        this.isMock = !this.accSid || !this.accSid.startsWith('AC');

        if (this.isMock) {
            console.warn('[Twilio Service] ⚠️ Running in MOCK MODE. Real SMS will not be sent.');
        }
    }

    get client() {
        if (!this._client && !this.isMock) {
            this._client = twilio(this.accSid, this.authToken);
        }
        return this._client;
    }

    /**
     * Send OTP to a phone number
     * @param {string} phone - Format like +919876543210
     */
    async sendVerification(phone) {
        if (this.isMock) {
            console.log(`[Twilio Mock] Sending OTP to ${phone}. Success simulated.`);
            return { status: 'pending' };
        }

        try {
            const verification = await this.client.verify.v2.services(this.serviceSid)
                .verifications
                .create({ to: phone, channel: 'sms' });
            return verification;
        } catch (error) {
            console.error('Twilio Send Error:', error);
            throw new Error(error.message);
        }
    }

    /**
     * Check/Verify OTP
     * @param {string} phone 
     * @param {string} code 
     */
    async checkVerification(phone, code) {
        if (this.isMock) {
            console.log(`[Twilio Mock] Verifying code ${code} for ${phone}.`);
            return code === '123456'; // Default mock success code
        }

        try {
            const verificationCheck = await this.client.verify.v2.services(this.serviceSid)
                .verificationChecks
                .create({ to: phone, code: code });

            return verificationCheck.status === 'approved';
        } catch (error) {
            console.error('Twilio Verify Error:', error);
            throw new Error(error.message);
        }
    }
}

module.exports = new TwilioService();
