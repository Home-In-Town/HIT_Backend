
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

async function checkEmployeeOwner() {
    try {
        await mongoose.connect(process.env.MONGODB_CONNECTION_URL);
        console.log('Connected to MongoDB');

        const employee = await User.findOne({ role: 'employee' });
        if (employee) {
            console.log('Employee Found:');
            console.log(`Name: ${employee.name}`);
            console.log(`Phone: ${employee.phone}`);
            console.log(`EmployerID: ${employee.employerId}`);
            console.log(`Is Confirmed: ${employee.isEmployerConfirmed}`);
            
            if (employee.employerId) {
                const employer = await User.findById(employee.employerId);
                if (employer) {
                    console.log('Employer Found:');
                    console.log(`Name: ${employer.name}`);
                    console.log(`Role: ${employer.role}`);
                }
            }
        } else {
            console.log('No employee found');
        }

        await mongoose.disconnect();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkEmployeeOwner();
