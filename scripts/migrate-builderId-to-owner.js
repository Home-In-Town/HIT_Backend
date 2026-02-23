/**
 * Migration Script: Rename builderId → owner in Projects collection
 * 
 * Run this ONCE against your MongoDB database before deploying:
 *   node scripts/migrate-builderId-to-owner.js
 * 
 * Or via mongo shell:
 *   db.projects.updateMany({}, { $rename: { "builderId": "owner" } })
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function migrate() {
    if (!MONGO_URI) {
        console.error('❌ No MONGODB_URI or MONGO_URI found in .env');
        process.exit(1);
    }

    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);

    const db = mongoose.connection.db;
    const collection = db.collection('projects');

    // Check current state
    const withBuilderId = await collection.countDocuments({ builderId: { $exists: true } });
    const withOwner = await collection.countDocuments({ owner: { $exists: true } });

    console.log(`📊 Current state: ${withBuilderId} docs with 'builderId', ${withOwner} docs with 'owner'`);

    if (withBuilderId === 0) {
        console.log('✅ No documents with "builderId" found. Migration already complete or not needed.');
        await mongoose.disconnect();
        return;
    }

    // Rename builderId → owner
    const result = await collection.updateMany(
        { builderId: { $exists: true } },
        { $rename: { builderId: 'owner' } }
    );

    console.log(`✅ Migration complete: ${result.modifiedCount} documents updated (builderId → owner)`);

    // Verify
    const remaining = await collection.countDocuments({ builderId: { $exists: true } });
    const newOwner = await collection.countDocuments({ owner: { $exists: true } });
    console.log(`📊 After migration: ${remaining} docs with 'builderId', ${newOwner} docs with 'owner'`);

    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB.');
}

migrate().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
