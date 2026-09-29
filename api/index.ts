import "dotenv/config";

import type { Request, Response } from "express";

import { createApp } from "../src/app";
import { connectDB, createIndexes } from "../src/shared/db";

/**
 * Vercel serverless entry point.
 *
 * `src/index.ts` cannot be used as-is: it calls `app.listen()`, which binds a
 * port. A serverless function has no long-lived process — Vercel invokes this
 * module per request and expects it to write to `res`. So the Express app is
 * reused as a plain `(req, res)` handler instead.
 *
 * The database is connected lazily and the promise is cached at module scope.
 * Module scope survives across invocations on a warm instance, so the first
 * request pays the handshake and every later request reuses the same client.
 * On failure the cache is cleared so the next invocation can retry a cold
 * cluster instead of replaying the rejection forever.
 */
let ready: Promise<void> | null = null;

function ensureDB(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await connectDB();
      await createIndexes();
    })().catch((error: unknown) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

const app = createApp();

export default async function handler(req: Request, res: Response): Promise<void> {
  try {
    await ensureDB();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[fatal] could not connect to MongoDB:", error);
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        message: "Service unavailable — the database is unreachable",
        data: null,
      });
    }
    return;
  }

  app(req, res);
}
