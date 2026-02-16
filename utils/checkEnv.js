const checkEnv = () => {
    const requiredVars = ['MONGODB_CONNECTION_URL'];
    const missing = requiredVars.filter(v => !process.env[v]);

    if (missing.length > 0) {
        console.error('❌ CRITICAL ERROR: Missing required environment variables:');
        missing.forEach(v => console.error(`   - ${v}`));
        console.error('\nPlease check your .env file or deployment settings.');
        process.exit(1);
    }

    console.log('🛡️  Environment variables validated.');
};

module.exports = checkEnv;
