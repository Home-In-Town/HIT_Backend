
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

async function checkAdmins() {
    try {
        await mongoose.connect(process.env.MONGODB_CONNECTION_URL);
        console.log('Connected to MongoDB');

        const admins = await User.find({ role: 'admin' });
        console.log(`Found ${admins.length} admins:`);
        admins.forEach(admin => {
            console.log(`- Name: ${admin.name}, Phone: ${admin.phone}, Email: ${admin.email}`);
        });

        const builders = await User.find({ role: 'builder' });
        console.log(`Found ${builders.length} builders:`);
        builders.forEach(builder => {
            console.log(`- Name: ${builder.name}, Phone: ${builder.phone}`);
        });

        await mongoose.disconnect();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkAdmins();
