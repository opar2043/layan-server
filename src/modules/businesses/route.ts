import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole, optionalAuth } from "../../shared/auth.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import {
  getBusinessById,
  getMyBusiness,
  listBusinesses,
  listPendingBusinesses,
  updateMyBusiness,
  verifyBusiness,
} from "./businesses";

const router = Router();

/**
 * ROUTE ORDER MATTERS.
 * "/me" and "/pending" are declared before "/:id", otherwise Express would match
 * them against the catch-all param route and look for a business with that id.
 */

/** GET /api/businesses — public discovery (optional auth just widens admin results). */
router.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) =>
    listBusinesses(req.query as Record<string, unknown>, res, req.auth)
  )
);

/** GET /api/businesses/me — owner only. */
router.get(
  "/me",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return getMyBusiness(req.auth, res);
  })
);

/** PATCH /api/businesses/me — owner only, whitelisted fields. */
router.patch(
  "/me",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return updateMyBusiness(req.auth, req.body as Record<string, unknown>, res);
  })
);

/** GET /api/businesses/pending — admin review queue. */
router.get(
  "/pending",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (_req, res) => listPendingBusinesses(res))
);

/** PATCH /api/businesses/:id/verify — admin decision. */
router.patch(
  "/:id/verify",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) =>
    verifyBusiness(
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    )
  )
);

/** GET /api/businesses/:id — public profile. Registered LAST (catch-all). */
router.get(
  "/:id",
  asyncHandler(async (req, res) => getBusinessById(req.params as Record<string, string>, res))
);

export default router;
