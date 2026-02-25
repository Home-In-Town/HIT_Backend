require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function listUsers() {
    try {
        await mongoose.connect(process.env.MONGODB_CONNECTION_URL);
        console.log('✅ Connected to MongoDB');

        const users = await User.find().limit(5);
        console.log(`Found ${users.length} users.`);
        users.forEach(u => console.log(`- ${u.name} (${u.phone})`));

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.disconnect();
    }
}

listUsers();
