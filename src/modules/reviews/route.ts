import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { requireFirebaseUser } from "../../shared/firebase.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import { createReview, listReviews, replyToReview } from "./reviews";

const router = Router();

/** POST /api/reviews — customer only, one per attended booking. */
router.post(
  "/",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    createReview(req.firebaseUid, req.body as Record<string, unknown>, res)
  )
);

/** GET /api/reviews?businessId= — public. */
router.get(
  "/",
  asyncHandler(async (req, res) => listReviews(req.query as Record<string, unknown>, res))
);

/** PATCH /api/reviews/:id/reply — owner of the reviewed business only. */
router.patch(
  "/:id/reply",
  requireAuth,
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return replyToReview(
      req.auth,
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res
    );
  })
);

export default router;
