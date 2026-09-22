import "dotenv/config";
import app from "./src/app";
import { connectDb, disconnectDb } from "./src/shared/db";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "layan";
const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  try {
    await connectDb(MONGODB_URI, DB_NAME);
    console.log(`Connected to MongoDB database "${DB_NAME}"`);
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
});

const shutdown = async () => {
  server.close();
  await disconnectDb();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
