import { Router } from "express";
import authRoutes from "../module/auth/route";
import customerRoutes from "../module/customer/route";
import businessRoutes from "../module/business/route";
import staffRoutes from "../module/staff/route";
import adminRoutes from "../module/admin/route";
import publicRoutes from "../module/public/route";
import conversationRoutes from "../module/conversations/route";
import jobRoutes from "../module/jobs/route";

/**
 * The API surface.
 *
 * `/public` is intentionally mounted before every authenticated router so that
 * the marketplace stays reachable without a token, and `/jobs` is last because
 * it authenticates with a shared secret rather than a user JWT.
 */
const router = Router();

router.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok", service: "layan-api" } });
});

/**
 * The mount table, exported so tooling (the route smoke test, docs) enumerates
 * the same routes the server serves instead of keeping a second list.
 */
export const API_MODULES = [
  { prefix: "/public", router: publicRoutes },
  { prefix: "/auth", router: authRoutes },
  { prefix: "/customer", router: customerRoutes },
  { prefix: "/business", router: businessRoutes },
  { prefix: "/staff", router: staffRoutes },
  { prefix: "/admin", router: adminRoutes },
  { prefix: "/conversations", router: conversationRoutes },
  { prefix: "/jobs", router: jobRoutes },
] as const;

for (const { prefix, router: moduleRouter } of API_MODULES) {
  router.use(prefix, moduleRouter);
}

export default router;
