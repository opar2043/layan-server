import "dotenv/config";
import app from "./src/app";
import { config } from "./src/shared/config";
import { connectDb, disconnectDb, ensureIndexes, isDbConnected } from "./src/shared/db";
import { startScheduler } from "./src/module/jobs/jobs";

/**
 * Connect and index *before* listening. The previous order accepted traffic while
 * the database was still connecting, so the first requests after a cold start
 * failed even though the process looked healthy.
 */
async function main(): Promise<void> {
  await connectDb(config.mongoUri, config.dbName);
  console.log(`Connected to MongoDB database "${config.dbName}"`);
  await ensureIndexes();

  let scheduler: { stop: () => void } | null = null;
  if (config.schedulerEnabled) {
    scheduler = startScheduler();
    console.log("In-process scheduler started");
  } else {
    console.log("In-process scheduler disabled (use POST /api/jobs/run instead)");
  }

  const server = app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`);
    scheduler?.stop();
    server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});

void isDbConnected;
