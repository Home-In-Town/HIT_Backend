const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');

async function checkUsers() {
    try {
        await mongoose.connect(process.env.MONGODB_CONNECTION_URL);
        console.log('Connected to DB');
        const users = await User.find({}).limit(5);
        console.log('Found users:', users.map(u => ({ id: u._id, name: u.name, phone: u.phone, role: u.role })));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkUsers();
