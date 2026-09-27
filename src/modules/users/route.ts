import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { requireFirebaseUser } from "../../shared/firebase.middleware";
import { Role } from "../../types/enums";
import {
  getMe,
  listCustomers,
  syncCustomer,
  updateFavourites,
  updateMe,
} from "./users";

const router = Router();

/** POST /api/users/sync — create-or-return on first Firebase login. */
router.post(
  "/sync",
  requireFirebaseUser,
  asyncHandler(async (req, res) => syncCustomer(req.firebaseUid, req.body as Record<string, unknown>, res))
);

/**
 * GET /api/users/me — registered BEFORE "/" below so the literal path is not
 * swallowed by the admin list route.
 */
router.get(
  "/me",
  requireFirebaseUser,
  asyncHandler(async (req, res) => getMe(req.firebaseUid, res))
);

/** PATCH /api/users/me */
router.patch(
  "/me",
  requireFirebaseUser,
  asyncHandler(async (req, res) => updateMe(req.firebaseUid, req.body as Record<string, unknown>, res))
);

/** PATCH /api/users/me/favourites */
router.patch(
  "/me/favourites",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    updateFavourites(req.firebaseUid, req.body as Record<string, unknown>, res)
  )
);

/** GET /api/users — admin only. */
router.get(
  "/",
  requireAuth,
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => listCustomers(req.query as Record<string, unknown>, res))
);

export default router;
