import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { config } from "./shared/config";
import { sendError } from "./shared/response";
import { ApiError } from "./shared/errors";
import { isDbConnected } from "./shared/db";
import routes from "./routes";

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",").map((value) => value.trim()) ?? true,
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ message: "Layan API is running" });
});

/**
 * Readiness probe. Returns 503 until MongoDB is connected so a load balancer
 * never sends traffic to a process that would fail every query.
 */
app.get("/health", (_req, res) => {
  const connected = isDbConnected();
  res.status(connected ? 200 : 503).json({
    success: connected,
    data: { status: connected ? "ok" : "degraded", database: connected ? "connected" : "disconnected" },
  });
});

app.use("/api", routes);

app.use((_req, res) => sendError(res, 404, "Endpoint not found"));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ApiError) {
    return sendError(res, error.status, error.message, error.code, error.details);
  }
  console.error(error);
  return sendError(res, 500, "Internal server error");
});

export { app };
export default app;

void config;
