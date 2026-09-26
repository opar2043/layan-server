import { Router, type Request } from "express";
import { asyncHandler } from "../../middleware/error";
import { currentUser, requireAuth, requireRole } from "../../auth/middleware";
import { sendSuccess } from "../../shared/response";
import { queryInt, requireObject } from "../../shared/utils";
import { UserRole } from "../../types/enums";
import * as admin from "./admin";

/**
 * `/api/admin` — HTTP surface only. All rules live in `admin.ts`.
 *
 * The whole surface sits behind one guard: a valid token *and* the admin role
 * re-read from the database. There is no per-route role list to forget.
 */
const router = Router();

router.use(requireAuth, requireRole(UserRole.ADMIN));

const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

const paging = (req: Request): admin.Paging => {
  const query = req.query as Record<string, unknown>;
  return {
    page: queryInt(query, "page", 1, 1, 10_000),
    pageSize: queryInt(query, "pageSize", 25, 1, 100),
  };
};

const str = (req: Request, key: string): string | undefined =>
  typeof req.query[key] === "string" ? (req.query[key] as string) : undefined;

/** `GET /api/admin/dashboard` */
router.get(
  "/dashboard",
  asyncHandler(async (_req: Request, res) => sendSuccess(res, await admin.getDashboard())),
);

/** `GET /api/admin/users` */
router.get(
  "/users",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      await admin.listUsers(paging(req), {
        ...(str(req, "role") ? { role: str(req, "role") } : {}),
        ...(str(req, "status") ? { status: str(req, "status") } : {}),
        ...(str(req, "q") ? { q: str(req, "q") } : {}),
      }),
    ),
  ),
);

/** `PATCH /api/admin/users/:id/status` */
router.patch(
  "/users/:id/status",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.setUserStatus(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `PATCH /api/admin/users/:id/role` */
router.patch(
  "/users/:id/role",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.setUserRole(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `GET /api/admin/verification-requests` */
router.get(
  "/verification-requests",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.listVerificationRequests(paging(req), str(req, "status"))),
  ),
);

/** `POST /api/admin/verification-requests/:id/decision` */
router.post(
  "/verification-requests/:id/decision",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      await admin.decideVerificationRequest(currentUser(req).id, String(req.params.id), body(req)),
    ),
  ),
);

/** `GET /api/admin/fraud-flags` */
router.get(
  "/fraud-flags",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      await admin.listFraudFlags(paging(req), {
        ...(str(req, "status") ? { status: str(req, "status") } : {}),
        ...(str(req, "severity") ? { severity: str(req, "severity") } : {}),
      }),
    ),
  ),
);

/** `POST /api/admin/fraud-flags/run-detection` */
router.post(
  "/fraud-flags/run-detection",
  asyncHandler(async (req: Request, res) => {
    const requested = str(req, "businessId") ?? body(req).businessId;
    return sendSuccess(
      res,
      await admin.runFraudDetection(typeof requested === "string" ? requested : undefined),
    );
  }),
);

/** `PATCH /api/admin/fraud-flags/:id` */
router.patch(
  "/fraud-flags/:id",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.updateFraudFlag(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `GET /api/admin/reviews/moderation` */
router.get(
  "/reviews/moderation",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.listHeldReviews(paging(req))),
  ),
);

/** `POST /api/admin/reviews/:id/moderation` */
router.post(
  "/reviews/:id/moderation",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.moderateReview(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `GET /api/admin/disputes` */
router.get(
  "/disputes",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.listDisputes(paging(req), str(req, "status"))),
  ),
);

/** `POST /api/admin/disputes/:id/resolve` */
router.post(
  "/disputes/:id/resolve",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.resolveDispute(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `PATCH /api/admin/businesses/:id/status` */
router.patch(
  "/businesses/:id/status",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.setBusinessStatus(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `GET /api/admin/badge-awards` */
router.get(
  "/badge-awards",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await admin.listBadgeAwards(paging(req), str(req, "businessId"))),
  ),
);

/** `GET /api/admin/audit-logs` */
router.get(
  "/audit-logs",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      await admin.listAuditLogs(paging(req), {
        ...(str(req, "adminId") ? { adminId: str(req, "adminId") } : {}),
        ...(str(req, "targetType") ? { targetType: str(req, "targetType") } : {}),
        ...(str(req, "targetId") ? { targetId: str(req, "targetId") } : {}),
      }),
    ),
  ),
);

export { requireObject };
export default router;
