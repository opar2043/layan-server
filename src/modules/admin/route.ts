import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { identifyAny, resolveActor } from "../../shared/identify.middleware";
import { Role } from "../../types/enums";
import { findCustomerIdByFirebaseUid } from "../users/users";
import {
  createDispute,
  getAnalytics,
  getFraudFlags,
  listDisputes,
  resolveDispute,
} from "./admin";

const router = Router();

/** GET /api/admin/analytics — admin only. */
router.get(
  "/analytics",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (_req, res) => getAnalytics(res))
);

/** GET /api/admin/fraud-flags — admin only. */
router.get(
  "/fraud-flags",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (_req, res) => getFraudFlags(res))
);

/** POST /api/admin/disputes — customer or business, on a booking they are party to. */
router.post(
  "/disputes",
  identifyAny,
  asyncHandler(async (req, res) => {
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return createDispute(req.body as Record<string, unknown>, res, actor);
  })
);

/** GET /api/admin/disputes — admin only, optional ?status=. */
router.get(
  "/disputes",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => listDisputes(req.query as Record<string, unknown>, res))
);

/** PATCH /api/admin/disputes/:id — admin only. */
router.patch(
  "/disputes/:id",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) =>
    resolveDispute(
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    )
  )
);

export default router;
