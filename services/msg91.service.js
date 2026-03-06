const axios = require('axios');

class Msg91Service {
    constructor() {
        this.authKey = process.env.MSG91_AUTH_KEY;
        this.templateId = process.env.MSG91_TEMPLATE_ID;

        this.baseUrl = 'https://control.msg91.com/api/v5/otp';

        // Check if we are in mock mode (missing authKey or placeholder)
        this.isMock = !this.authKey || this.authKey === 'your_msg91_authkey_here';

        if (this.isMock) {
            console.warn('[MSG91 Service] ⚠️ Running in MOCK MODE. Real SMS will not be sent.');
        }
    }

    /**
     * Send OTP to a phone number
     * @param {string} phone - Format like +919876543210
     */
    async sendVerification(phone) {
        if (this.isMock) {
            console.log(`[MSG91 Mock] Sending OTP to ${phone}. Success simulated.`);
            return { type: 'success', message: 'OTP sent successfully' };
        }

        try {
            // MSG91 recommends passing the mobile number without the '+' symbol
            const cleanPhone = phone.replace('+', '');
            console.log(`[MSG91 Service] Preparing to send OTP via MSG91 to clean phone number: ${cleanPhone}`);
            console.log(`[MSG91 Service] Template ID: ${this.templateId}`);

            const response = await axios.get(this.baseUrl, {
                params: {
                    template_id: this.templateId,
                    mobile: cleanPhone,
                },
                headers: {
                    'authkey': this.authKey
                }
            });

            console.log(`[MSG91 Service] Successfully dispatched request to MSG91! Response:`, response.data);
            return response.data;
        } catch (error) {
            console.error('MSG91 Send Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || error.message);
        }
    }

    /**
     * Check/Verify OTP
     * @param {string} phone 
     * @param {string} code 
     */
    async checkVerification(phone, code) {
        if (this.isMock) {
            console.log(`[MSG91 Mock] Verifying code ${code} for ${phone}.`);
            return code === '123456'; // Default mock success code
        }

        try {
            const cleanPhone = phone.replace('+', '');

            const response = await axios.get(`${this.baseUrl}/verify`, {
                params: {
                    otp: code,
                    mobile: cleanPhone,
                },
                headers: {
                    'authkey': this.authKey
                }
            });

            // MSG91 returns type: 'success' when OTP is correct
            return response.data.type === 'success' || response.data.type === 'success';
        } catch (error) {
            console.error('MSG91 Verify Error:', error.response?.data || error.message);
            // If the OTP is incorrect, MSG91 usually returns an error response
            if (error.response?.data?.type === 'error') {
                return false;
            }
            throw new Error(error.response?.data?.message || error.message);
        }
    }
}

module.exports = new Msg91Service();
