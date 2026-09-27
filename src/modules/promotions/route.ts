import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import {
  createPromotion,
  deactivatePromotion,
  listPromotions,
  updatePromotion,
} from "./promotions";

const router = Router();

/** POST /api/promotions — owner (scoped) or admin (platform-wide). */
router.post(
  "/",
  requireAuth,
  requireRole(Role.OWNER, Role.ADMIN),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return createPromotion(req.auth, req.body as Record<string, unknown>, res);
  })
);

/** GET /api/promotions?businessId= — public, currently-valid promotions only. */
router.get(
  "/",
  asyncHandler(async (req, res) => listPromotions(req.query as Record<string, unknown>, res))
);

/** PATCH /api/promotions/:id */
router.patch(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER, Role.ADMIN),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return updatePromotion(
      req.auth,
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    );
  })
);

/** DELETE /api/promotions/:id — soft-deactivates. */
router.delete(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER, Role.ADMIN),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return deactivatePromotion(req.auth, req.params as Record<string, string>, res);
  })
);

export default router;
