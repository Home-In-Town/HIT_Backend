
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

async function testApiLogic() {
    await mongoose.connect(process.env.MONGODB_CONNECTION_URL);
    console.log('Connected to MongoDB');

    // 1. Test as Admin
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        console.log(`Testing as Admin: ${admin.name}`);
        const query = { role: 'employee' };
        const employees = await User.find(query).select('name phone email isActive');
        console.log(`Admin found ${employees.length} employees`);
    }

    // 2. Test as Builder
    const builder = await User.findOne({ role: 'builder' });
    if (builder) {
        console.log(`Testing as Builder: ${builder.name} (${builder._id})`);
        const query = {
            employerId: builder._id,
            isEmployerConfirmed: true
        };
        const employees = await User.find(query).select('name phone email isActive');
        console.log(`Builder found ${employees.length} employees`);
    }

    await mongoose.disconnect();
}

testApiLogic();
