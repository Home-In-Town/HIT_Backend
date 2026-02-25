const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = 'mongodb+srv://leadgen_HIT:k80soJRxFWRqq2e7@hit-db.pxugtcd.mongodb.net/';

async function checkUser() {
    try {
        console.log('Connecting to Sales Website DB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected.');

        const phone = '9999999903';
        console.log(`Checking user with phone: ${phone}`);

        const user = await User.findOne({ phone: phone });

        if (user) {
            console.log('✅ User found:');
            console.log(JSON.stringify({
                id: user._id,
                name: user.name,
                role: user.role,
                phone: user.phone,
                isActive: user.isActive
            }, null, 2));
        } else {
            console.log('❌ User NOT found with phone:', phone);
            // Let's also list all users to see if maybe the phone number is slightly different
            const allUsers = await User.find({}).limit(10);
            console.log('Recent users:', allUsers.map(u => ({ name: u.name, phone: u.phone, role: u.role })));
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit(0);
    }
}

checkUser();
