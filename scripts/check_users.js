
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

async function checkUsers() {
    try {
        await mongoose.connect(process.env.MONGODB_CONNECTION_URL);
        console.log('Connected to MongoDB');

        const roles = ['admin', 'builder', 'agent', 'unassigned', 'user', 'employee'];
        for (const role of roles) {
            const count = await User.countDocuments({ role });
            console.log(`Role ${role}: ${count}`);
        }

        const pendingEmployees = await User.countDocuments({ 
            employerId: { $ne: null }, 
            isEmployerConfirmed: false 
        });
        console.log(`Pending Employees (assigned but not confirmed): ${pendingEmployees}`);

        const confirmedEmployees = await User.countDocuments({ 
            employerId: { $ne: null }, 
            isEmployerConfirmed: true 
        });
        console.log(`Confirmed Employees: ${confirmedEmployees}`);

        await mongoose.disconnect();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkUsers();
