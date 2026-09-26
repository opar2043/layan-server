import { Router, type Request } from "express";
import { asyncHandler } from "../../middleware/error";
import { currentUser, requireAuth, requireRole } from "../../auth/middleware";
import { redactionContext, serializeBooking } from "../../serializers";
import { sendSuccess } from "../../shared/response";
import { queryInt } from "../../shared/utils";
import { UserRole } from "../../types/enums";
import * as staff from "./staff";

/**
 * `/api/staff` — the signed-in stylist/manager's own work. All rules live in
 * `staff.ts`; this file only reads the request and shapes the response.
 */
const router = Router();

router.use(requireAuth, requireRole(UserRole.STAFF));

const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

/** `GET /api/staff/me` */
router.get(
  "/me",
  asyncHandler(async (req: Request, res) => {
    const row = await staff.requireOwnStaff(currentUser(req).id);
    return sendSuccess(res, { staff: staff.describeOwnStaff(row) });
  }),
);

/** `GET /api/staff/schedule` — no `staffId` parameter exists here by design. */
router.get(
  "/schedule",
  asyncHandler(async (req: Request, res) => {
    const query = req.query as Record<string, unknown>;
    const row = await staff.requireOwnStaff(currentUser(req).id);
    const result = await staff.listOwnSchedule(row, {
      page: queryInt(query, "page", 1, 1, 10_000),
      pageSize: queryInt(query, "pageSize", 25, 1, 100),
      ...(typeof query.status === "string" ? { status: query.status } : {}),
      ...(typeof query.from === "string" ? { from: query.from } : {}),
      ...(typeof query.to === "string" ? { to: query.to } : {}),
    });

    const ctx = redactionContext(req);
    return sendSuccess(res, {
      data: result.docs.map((doc) => serializeBooking(doc, ctx)),
      page: queryInt(query, "page", 1, 1, 10_000),
      pageSize: queryInt(query, "pageSize", 25, 1, 100),
      total: result.total,
      totalPages: Math.ceil(result.total / queryInt(query, "pageSize", 25, 1, 100)),
    });
  }),
);

/** `GET /api/staff/today` */
router.get(
  "/today",
  asyncHandler(async (req: Request, res) => {
    const row = await staff.requireOwnStaff(currentUser(req).id);
    const result = await staff.listToday(row);
    const ctx = redactionContext(req);
    return sendSuccess(res, {
      date: result.date,
      count: result.bookings.length,
      bookings: result.bookings.map((doc) => serializeBooking(doc, ctx)),
    });
  }),
);

/** `POST /api/staff/bookings/:id/complete` */
router.post(
  "/bookings/:id/complete",
  asyncHandler(async (req: Request, res) => {
    const result = await staff.completeBooking(currentUser(req).id, String(req.params.id));
    return sendSuccess(res, serializeBooking(result.booking, redactionContext(req)));
  }),
);

/** `POST /api/staff/bookings/:id/no-show` */
router.post(
  "/bookings/:id/no-show",
  asyncHandler(async (req: Request, res) => {
    const result = await staff.markNoShow(currentUser(req).id, String(req.params.id), body(req));
    return sendSuccess(res, {
      booking: serializeBooking(result.booking, redactionContext(req)),
      depositOutcome: result.outcome,
    });
  }),
);

/** `GET /api/staff/availability` */
router.get(
  "/availability",
  asyncHandler(async (req: Request, res) => {
    const query = req.query as Record<string, unknown>;
    const row = await staff.requireOwnStaff(currentUser(req).id);
    return sendSuccess(
      res,
      await staff.ownAvailability(
        row,
        String(query.serviceId),
        queryInt(query, "days", 7, 1, 60),
      ),
    );
  }),
);

/** `GET /api/staff/customers` */
router.get(
  "/customers",
  asyncHandler(async (req: Request, res) => {
    const row = await staff.requireOwnStaff(currentUser(req).id);
    return sendSuccess(res, await staff.ownCustomers(row));
  }),
);

/** `GET /api/staff/performance` */
router.get(
  "/performance",
  asyncHandler(async (req: Request, res) => {
    const row = await staff.requireOwnStaff(currentUser(req).id);
    return sendSuccess(res, await staff.ownPerformance(row));
  }),
);

/** `GET /api/staff/conversations` */
router.get(
  "/conversations",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      await staff.listBusinessConversations(
        currentUser(req).id,
        String(req.query.businessId ?? req.params.businessId ?? ""),
      ),
    ),
  ),
);

/** `POST /api/staff/bookings/:id/nudge` */
router.post(
  "/bookings/:id/nudge",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await staff.nudgeCustomer(currentUser(req).id, String(req.params.id)), 201),
  ),
);

export default router;
