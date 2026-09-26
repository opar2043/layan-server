import "dotenv/config";
import type { IncomingMessage, ServerResponse } from "http";
import app from "../src/app";
import { config } from "../src/shared/config";
import { connectDb, ensureIndexes, isDbConnected } from "../src/shared/db";

/**
 * Serverless entry point. Connect once per cold start; indexes are cheap to
 * reconcile and avoid a first-request race. The in-process scheduler is
 * deliberately not started here — invoke `POST /api/jobs/run` from the
 * platform's cron instead.
 */
let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!isDbConnected()) {
    ready ??= (async () => {
      await connectDb(config.mongoUri, config.dbName);
      await ensureIndexes();
    })();
  }
  return ready ?? Promise.resolve();
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await ensureReady();
  } catch (error) {
    console.error("Database connection failed:", error);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, error: { message: "Database unavailable" } }));
    return;
  }
  return app(req, res);
}
