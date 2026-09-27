import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { requireFirebaseUser } from "../../shared/firebase.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import {
  createWaitlistEntry,
  deleteWaitlistEntry,
  listWaitlist,
  updateWaitlistEntry,
} from "./waitlist";

const router = Router();

/** POST /api/waitlist — customer only. */
router.post(
  "/",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    createWaitlistEntry(req.firebaseUid, req.body as Record<string, unknown>, res)
  )
);

/** DELETE /api/waitlist/:id — customer removes their own entry. */
router.delete(
  "/:id",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    deleteWaitlistEntry(req.firebaseUid, req.params as Record<string, string>, res)
  )
);

/** GET /api/waitlist — owner only, scoped to their business. */
router.get(
  "/",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return listWaitlist(req.auth, req.query as Record<string, unknown>, res);
  })
);

/** PATCH /api/waitlist/:id — owner only. */
router.patch(
  "/:id",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return updateWaitlistEntry(
      req.auth,
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    );
  })
);

export default router;
