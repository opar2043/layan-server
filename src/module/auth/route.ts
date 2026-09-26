import { Router, type Request } from "express";
import { asyncHandler } from "../../middleware/error";
import { currentUser, requireAuth } from "../../auth/middleware";
import { sendSuccess } from "../../shared/response";
import { serializeUser } from "../../serializers";
import * as auth from "./auth";

/**
 * `/api/auth` — HTTP surface only. All rules live in `auth.ts`.
 */
const router = Router();

const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

/** `POST /api/auth/register` */
router.post(
  "/register",
  asyncHandler(async (req: Request, res) => {
    const result = await auth.register(body(req));
    return sendSuccess(
      res,
      { token: result.token, user: serializeUser(result.user, { self: true }) },
      201,
    );
  }),
);

/** `POST /api/auth/login` */
router.post(
  "/login",
  asyncHandler(async (req: Request, res) => {
    const result = await auth.login(body(req));
    return sendSuccess(res, { token: result.token, user: serializeUser(result.user, { self: true }) });
  }),
);

/** `POST /api/auth/refresh` */
router.post(
  "/refresh",
  requireAuth,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await auth.refreshToken(currentUser(req).id)),
  ),
);

/** `GET /api/auth/me` — the caller's own record, self-serialised. */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, serializeUser(await auth.getUser(currentUser(req).id), { self: true })),
  ),
);

/** `PATCH /api/auth/me` */
router.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeUser(await auth.updateProfile(currentUser(req).id, body(req)), { self: true }),
    ),
  ),
);

/** `POST /api/auth/change-password` */
router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req: Request, res) => {
    const payload = body(req);
    return sendSuccess(
      res,
      await auth.changePassword(
        currentUser(req).id,
        payload.currentPassword,
        payload.newPassword,
      ),
    );
  }),
);

/** `GET /api/auth/sessions` */
router.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await auth.listSessions(currentUser(req).id)),
  ),
);

/** `POST /api/auth/logout` — stateless tokens, so this only records intent. */
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (_req: Request, res) =>
    sendSuccess(res, { message: "Signed out. Discard your access token." }),
  ),
);

export default router;
