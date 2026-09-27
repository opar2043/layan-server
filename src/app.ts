import cors from "cors";
import express, { Express } from "express";
import morgan from "morgan";

import { sendSuccess } from "./shared/apiResponse";
import { errorHandler, notFoundHandler } from "./shared/errorHandler";

import authRoutes from "./modules/auth/route";
import userRoutes from "./modules/users/route";
import businessRoutes from "./modules/businesses/route";
import serviceRoutes from "./modules/services/route";
import staffRoutes from "./modules/staff/route";
import bookingRoutes from "./modules/bookings/route";
import waitlistRoutes from "./modules/waitlist/route";
import reviewRoutes from "./modules/reviews/route";
import walletRoutes from "./modules/wallet/route";
import messageRoutes from "./modules/messages/route";
import promotionRoutes from "./modules/promotions/route";
import adminRoutes from "./modules/admin/route";

/**
 * Builds the Express app. It does NOT listen — that is index.ts's job, which keeps
 * the app importable from tests without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan("dev"));

  app.get("/health", (_req, res) => sendSuccess(res, 200, "Layan server is healthy", null));

  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/businesses", businessRoutes);
  app.use("/api/services", serviceRoutes);
  app.use("/api/staff", staffRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/waitlist", waitlistRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/promotions", promotionRoutes);
  app.use("/api/admin", adminRoutes);

  // Registered LAST: unmatched route -> 404, thrown error -> single error envelope.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
