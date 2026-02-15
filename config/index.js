require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 5001,
  VOICE_API_BASE_URL: process.env.VOICE_API_BASE_URL
};
