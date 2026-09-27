import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth } from "../../shared/auth.middleware";
import { ApiError } from "../../shared/apiError";
import { login, me, registerOwner } from "./auth";

const router = Router();

/** POST /api/auth/register/owner — public owner + business signup. */
router.post(
  "/register/owner",
  asyncHandler(async (req, res) => registerOwner(req.body as Record<string, unknown>, res))
);

/** POST /api/auth/login — public login for owner | staff | admin. */
router.post(
  "/login",
  asyncHandler(async (req, res) => login(req.body as Record<string, unknown>, res))
);

/** GET /api/auth/me — resolves the profile behind the supplied token. */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    return me(req.auth, res);
  })
);

export default router;
