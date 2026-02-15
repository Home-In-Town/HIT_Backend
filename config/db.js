const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_CONNECTION_URL;
    if (!uri) {
      throw new Error("MONGODB_CONNECTION_URL is missing in environment variables");
    }
    console.log(`🔌 Connecting to MongoDB with URI: ${uri.replace(/:([^:@]+)@/, ':****@')}`);

    const conn = await mongoose.connect(uri, {
      dbName: 'salesdb',
      serverSelectionTimeoutMS: 5000
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error details:`);
    console.error(error); // Log full error object
    process.exit(1);
  }
};

module.exports = connectDB;
