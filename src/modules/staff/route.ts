import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import { createStaff, deleteStaff, getStaff, listStaff, updateStaff } from "./staff";

const router = Router();

/** POST /api/staff — owner only. */
router.post(
  "/",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return createStaff(req.auth, req.body as Record<string, unknown>, res);
  })
);

/** GET /api/staff — owner only, scoped to their own business. */
router.get(
  "/",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return listStaff(req.auth, req.query as Record<string, unknown>, res);
  })
);

/** GET /api/staff/:id — owner of the business, or the staff member themselves. */
router.get(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return getStaff(req.auth, req.params as Record<string, string>, res);
  })
);

/** PATCH /api/staff/:id — owner edits anything in their business; staff edits own hours. */
router.patch(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return updateStaff(
      req.auth,
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    );
  })
);

/** DELETE /api/staff/:id — owner only, soft delete. */
router.delete(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return deleteStaff(req.auth, req.params as Record<string, string>, res);
  })
);

export default router;
