import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole, optionalAuth } from "../../shared/auth.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import { createService, deleteService, getService, listServices, updateService } from "./services";

const router = Router();

/** POST /api/services — owner only. */
router.post(
  "/",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return createService(req.auth, req.body as Record<string, unknown>, res);
  })
);

/** GET /api/services?businessId= — public; owner/staff may omit businessId. */
router.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) =>
    listServices(req.query as Record<string, unknown>, res, req.auth)
  )
);

/** GET /api/services/:id — public. */
router.get(
  "/:id",
  asyncHandler(async (req, res) => getService(req.params as Record<string, string>, res))
);

/** PATCH /api/services/:id — owner of the service only. */
router.patch(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return updateService(
      req.auth,
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    );
  })
);

/** DELETE /api/services/:id — soft delete (isActive = false). */
router.delete(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return deleteService(req.auth, req.params as Record<string, string>, res);
  })
);

export default router;
