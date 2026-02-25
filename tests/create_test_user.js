require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function createUser() {
    try {
        await mongoose.connect(process.env.MONGODB_CONNECTION_URL, { dbName: 'salesdb' });
        console.log('✅ Connected to MongoDB');

        const userData = {
            name: 'Test Builder',
            email: 'testbuilder8789485074@example.com',
            phone: '8789485074',
            role: 'builder',
            companyName: 'Test Construction Co'
        };

        // Check if user exists first to avoid duplicate email error
        const existing = await User.findOne({ phone: userData.phone });
        if (existing) {
            console.log('User already exists:', existing);
            return;
        }

        // Check if email exists
        const existingEmail = await User.findOne({ email: userData.email });
        if (existingEmail) {
            console.log('User with this email already exists:', existingEmail);
            // Delete to recreate or just update?
            // Let's just create new if phone matches
        }

        const newUser = await User.create(userData);
        console.log('🎉 User created successfully:', newUser);

    } catch (error) {
        console.error('❌ Error creating user:', error);
    } finally {
        await mongoose.disconnect();
    }
}

createUser();
