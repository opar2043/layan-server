import { Router, type Request } from "express";
import { ApiError } from "../../shared/errors";
import { asyncHandler } from "../../middleware/error";
import {
  currentUser,
  requireAuth,
  requireBusinessAccess,
  requireOwnerOnly,
  requirePermission,
  requireRole,
  requireStaffManagement,
} from "../../auth/middleware";
import { redactionContext, serializeBooking, serializeCustomerRecord, serializeReview } from "../../serializers";
import { sendSuccess } from "../../shared/response";
import { parseDateKey, queryInt, requireObject, requireString } from "../../shared/utils";
import { UserRole } from "../../types/enums";
import {
  addCustomerNote,
  addPortfolioItem,
  addPromotion,
  addStaffMember,
  changeBookingStatusAsBusiness,
  createLocation,
  createService,
  createTimeOff,
  deleteTimeOff,
  getAvailability,
  getBusiness,
  getBusinessBooking,
  getCustomerDetail,
  getDashboard,
  getLastMinutePromotion,
  issueRefund,
  listBusinessAuditLogs,
  listBusinessBookings,
  listBusinessReviews,
  listAccessibleBusinesses,
  listCalendar,
  listCustomers,
  listDisputes,
  listInstantSlots,
  listLocations,
  listPayouts,
  listPayments,
  listPortfolio,
  listPromotions,
  listServices,
  listStaff,
  listTimeOff,
  listWaitlist,
  messageCustomer,
  notifyWaitlistEntry,
  paginate,
  publishInstantSlot,
  recomputeInsights,
  recomputeScoreAndBadges,
  rescheduleAsBusiness,
  respondToDispute,
  suspendStaffMember,
  updateBusiness,
  updatePromotion,
  updateService,
  updateStaffMember,
  type AccessGate,
  type Paging,
  type RangeFilters,
} from "./business";

/**
 * Business/owner/staff HTTP surface. Every handler here is limited to parsing the
 * request, delegating to `./business`, and serializing the result — the rules
 * live in that file so they can be exercised without Express.
 *
 * The access middleware chain is part of the contract and is not optional:
 * `requireBusinessAccess(":businessId")` resolves ownership/permission once and
 * everything downstream reads it through `gate(req)`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.BUSINESS_OWNER, UserRole.STAFF, UserRole.ADMIN));

/**
 * The business id is always taken from a path/query parameter and then gated by
 * `requireBusinessAccess`. A body `businessId` is never trusted for access.
 */
function gate(req: Request): AccessGate {
  const found = req.businessAccess;
  if (!found) throw ApiError.forbidden("Business access has not been established");
  return {
    selfOnly: found.selfOnly,
    staffId: found.staffId,
    staffRole: found.staffRole as AccessGate["staffRole"],
    via: found.via,
  };
}

function paging(req: Request): Paging {
  const query = req.query as Record<string, unknown>;
  return {
    page: queryInt(query, "page", 1, 1, 10_000),
    pageSize: queryInt(query, "pageSize", 25, 1, 100),
  };
}

function range(req: Request): RangeFilters {
  const query = req.query as Record<string, unknown>;
  return {
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
  };
}

function businessIdOf(req: Request): string {
  return requireString(req.params.businessId, "businessId");
}

function queryString(req: Request, key: string): string | null {
  const value = req.query[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ------------------------------------------------------------------ profile

/** `GET /api/business/me` — every business the caller owns or works for. */
router.get(
  "/me",
  asyncHandler(async (req: Request, res) => {
    const user = currentUser(req);
    return sendSuccess(res, await listAccessibleBusinesses(user.id, user.role));
  }),
);

/** `GET /api/business/:businessId` — the full business record for authorised callers. */
router.get(
  "/:businessId",
  requireBusinessAccess(":businessId"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, {
      business: await getBusiness(businessIdOf(req)),
      access: req.businessAccess,
    });
  }),
);

/**
 * `PATCH /api/business/:businessId` — owner only. `badges`, `businessScore`,
 * `ratingSummary` and `verification` are all computed or admin-granted, so they
 * are stripped in the module even if a client posts them.
 */
router.patch(
  "/:businessId",
  requireBusinessAccess(":businessId"),
  requireOwnerOnly,
  asyncHandler(async (req: Request, res) => {
    const body = requireObject(req.body, "body");
    return sendSuccess(res, await updateBusiness(businessIdOf(req), body));
  }),
);

/** `GET /api/business/:businessId/dashboard` — owner/manager numbers for today. */
router.get(
  "/:businessId/dashboard",
  requireBusinessAccess(":businessId"),
  requirePermission("viewFinancials"),
  asyncHandler(async (req: Request, res) => {
    // `today` is destructured out: only the serialised `todayBookings` is sent, so
    // no unredacted booking field can leak through a spread.
    const { today, ...summary } = await getDashboard(businessIdOf(req));
    const ctx = redactionContext(req);
    return sendSuccess(res, {
      ...summary,
      todayBookings: today.map((booking) => serializeBooking(booking, ctx)),
    });
  }),
);

// ----------------------------------------------------------------- calendar

/**
 * `GET /api/business/:businessId/calendar`
 *
 * A stylist always sees only their own appointments — the filter is enforced in
 * the module's query, not hidden in the serializer.
 */
router.get(
  "/:businessId/calendar",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const { docs, total } = await listCalendar(
      businessIdOf(req),
      gate(req),
      page,
      range(req),
      queryString(req, "staffId"),
    );
    const ctx = redactionContext(req);
    return sendSuccess(res, paginate(docs.map((doc) => serializeBooking(doc, ctx)), total, page));
  }),
);

/** `GET /api/business/:businessId/availability` — owner view of bookable slots. */
router.get(
  "/:businessId/availability",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const query = req.query as Record<string, unknown>;
    const dateFrom =
      typeof query.date === "string" ? parseDateKey(query.date, "date") : new Date();
    const days = queryInt(query, "days", 7, 1, 60);

    return sendSuccess(
      res,
      await getAvailability(businessIdOf(req), requireString(query.serviceId, "serviceId"), dateFrom, days, {
        staffId: queryString(req, "staffId") ?? undefined,
        locationId: queryString(req, "locationId") ?? undefined,
      }),
    );
  }),
);

/** `GET /api/business/:businessId/time-off` — holidays and blocked time. */
router.get(
  "/:businessId/time-off",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listTimeOff(businessIdOf(req), gate(req), range(req)));
  }),
);

/** `POST /api/business/:businessId/time-off` — a stylist may block their own time. */
router.post(
  "/:businessId/time-off",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const doc = await createTimeOff(
      currentUser(req).id,
      businessIdOf(req),
      gate(req),
      requireObject(req.body, "body"),
    );
    return sendSuccess(res, doc, 201);
  }),
);

/** `DELETE /api/business/:businessId/time-off/:id` — releases blocked time. */
router.delete(
  "/:businessId/time-off/:id",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await deleteTimeOff(businessIdOf(req), gate(req), requireString(req.params.id, "id")),
    );
  }),
);

// ---------------------------------------------------------------- bookings

/** `GET /api/business/:businessId/bookings` — staff-facing booking list. */
router.get(
  "/:businessId/bookings",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const { docs, total } = await listBusinessBookings(businessIdOf(req), gate(req), page, {
      status: queryString(req, "status") ?? undefined,
      staffId: queryString(req, "staffId") ?? undefined,
    });
    const ctx = redactionContext(req);
    return sendSuccess(res, paginate(docs.map((doc) => serializeBooking(doc, ctx)), total, page));
  }),
);

/** `GET /api/business/:businessId/bookings/:id` — one booking, redaction applied. */
router.get(
  "/:businessId/bookings/:id",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const booking = await getBusinessBooking(
      businessIdOf(req),
      gate(req),
      requireString(req.params.id, "id"),
    );
    return sendSuccess(res, serializeBooking(booking, redactionContext(req)));
  }),
);

/**
 * `PATCH /api/business/:businessId/bookings/:id/status`
 *
 * A stylist may only mark their own appointment attended/no-show. The transition
 * itself is validated by the shared state machine, never by the controller.
 */
router.patch(
  "/:businessId/bookings/:id/status",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const result = await changeBookingStatusAsBusiness(
      currentUser(req).id,
      businessIdOf(req),
      gate(req),
      requireString(req.params.id, "id"),
      requireObject(req.body, "body"),
    );
    return sendSuccess(res, {
      booking: serializeBooking(result.booking, redactionContext(req)),
      depositOutcome: result.outcome,
    });
  }),
);

/** `POST /api/business/:businessId/bookings/:id/reschedule` — business-initiated move. */
router.post(
  "/:businessId/bookings/:id/reschedule",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const result = await rescheduleAsBusiness(
      currentUser(req).id,
      businessIdOf(req),
      requireString(req.params.id, "id"),
      requireObject(req.body, "body"),
    );
    return sendSuccess(res, serializeBooking(result.booking, redactionContext(req)));
  }),
);

/** `POST /api/business/:businessId/bookings/:id/instant-slot` — publish a cancellation. */
router.post(
  "/:businessId/bookings/:id/instant-slot",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    const result = await publishInstantSlot(
      currentUser(req).id,
      businessIdOf(req),
      requireString(req.params.id, "id"),
    );
    return sendSuccess(res, result, 201);
  }),
);

/** `GET /api/business/:businessId/instant-slots` — live discounted offers. */
router.get(
  "/:businessId/instant-slots",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listInstantSlots(businessIdOf(req)));
  }),
);

// ------------------------------------------------------------------ waitlist

/** `GET /api/business/:businessId/waitlist` — the queue, newest first. */
router.get(
  "/:businessId/waitlist",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listWaitlist(businessIdOf(req)));
  }),
);

/** `POST /api/business/:businessId/waitlist/:id/notify` — offers a freed slot. */
router.post(
  "/:businessId/waitlist/:id/notify",
  requireBusinessAccess(":businessId"),
  requirePermission("manageCalendar"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await notifyWaitlistEntry(
        currentUser(req).id,
        businessIdOf(req),
        requireString(req.params.id, "id"),
      ),
    );
  }),
);

// ----------------------------------------------------------------- customers

/**
 * `GET /api/business/:businessId/customers` — the CRM list. `insights` is
 * included here because this side is entitled to it (and only this side).
 */
router.get(
  "/:businessId/customers",
  requireBusinessAccess(":businessId"),
  requirePermission("viewCustomerData"),
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const { docs, total } = await listCustomers(
      businessIdOf(req),
      page,
      queryString(req, "q") ?? undefined,
    );
    const ctx = redactionContext(req);
    return sendSuccess(
      res,
      paginate(
        docs.map((doc) => serializeCustomerRecord(doc as unknown as Record<string, unknown>, ctx)),
        total,
        page,
      ),
    );
  }),
);

/** `GET /api/business/:businessId/customers/:id` — one CRM record with insights. */
router.get(
  "/:businessId/customers/:id",
  requireBusinessAccess(":businessId"),
  requirePermission("viewCustomerData"),
  asyncHandler(async (req: Request, res) => {
    const detail = await getCustomerDetail(businessIdOf(req), requireString(req.params.id, "id"));
    const ctx = redactionContext(req);
    return sendSuccess(res, {
      customer: serializeCustomerRecord(
        detail.customer as unknown as Record<string, unknown>,
        ctx,
      ),
      bookings: detail.bookings.map((doc) => serializeBooking(doc, ctx)),
      reviews: detail.reviews,
    });
  }),
);

/** `POST /api/business/:businessId/customers/:id/note` — appends an internal note. */
router.post(
  "/:businessId/customers/:id/note",
  requireBusinessAccess(":businessId"),
  requirePermission("viewCustomerData"),
  asyncHandler(async (req: Request, res) => {
    const added = await addCustomerNote(
      currentUser(req).id,
      businessIdOf(req),
      requireString(req.params.id, "id"),
      requireObject(req.body, "body"),
    );
    return sendSuccess(res, added, 201);
  }),
);

/** `POST /api/business/:businessId/customers/:id/message` — sends a notification. */
router.post(
  "/:businessId/customers/:id/message",
  requireBusinessAccess(":businessId"),
  requirePermission("viewCustomerData"),
  asyncHandler(async (req: Request, res) => {
    const notification = await messageCustomer(
      businessIdOf(req),
      requireString(req.params.id, "id"),
      requireObject(req.body, "body"),
    );
    return sendSuccess(res, notification, 201);
  }),
);

// -------------------------------------------------------------------- staff

/** `GET /api/business/:businessId/staff` — the team. */
router.get(
  "/:businessId/staff",
  requireBusinessAccess(":businessId"),
  requirePermission("viewCustomerData"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listStaff(businessIdOf(req), gate(req)));
  }),
);

/** `POST /api/business/:businessId/staff` — owner or manager only. */
router.post(
  "/:businessId/staff",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    const doc = await addStaffMember(businessIdOf(req), requireObject(req.body, "body"));
    return sendSuccess(res, doc, 201);
  }),
);

/**
 * `PATCH /api/business/:businessId/staff/:id`
 *
 * Permission flags are owner-only: a manager can edit a stylist's hours but can
 * never grant `viewFinancials` or `processRefunds` to themselves or anyone else.
 */
router.patch(
  "/:businessId/staff/:id",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await updateStaffMember(
        businessIdOf(req),
        gate(req),
        requireString(req.params.id, "id"),
        requireObject(req.body, "body"),
      ),
    );
  }),
);

/** `DELETE /api/business/:businessId/staff/:id` — suspends rather than deletes history. */
router.delete(
  "/:businessId/staff/:id",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await suspendStaffMember(businessIdOf(req), requireString(req.params.id, "id")),
    );
  }),
);

// ----------------------------------------------------------------- services

/** `GET /api/business/:businessId/services` — the price list. */
router.get(
  "/:businessId/services",
  requireBusinessAccess(":businessId"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listServices(businessIdOf(req)));
  }),
);

/** `POST /api/business/:businessId/services` — creates a bookable service. */
router.post(
  "/:businessId/services",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    const doc = await createService(businessIdOf(req), requireObject(req.body, "body"));
    return sendSuccess(res, doc, 201);
  }),
);

/** `PATCH /api/business/:businessId/services/:id` — edits price, duration, buffers. */
router.patch(
  "/:businessId/services/:id",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await updateService(
        businessIdOf(req),
        requireString(req.params.id, "id"),
        requireObject(req.body, "body"),
      ),
    );
  }),
);

// ---------------------------------------------------------------- locations

/** `GET /api/business/:businessId/locations` */
router.get(
  "/:businessId/locations",
  requireBusinessAccess(":businessId"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listLocations(businessIdOf(req)));
  }),
);

/** `POST /api/business/:businessId/locations` */
router.post(
  "/:businessId/locations",
  requireBusinessAccess(":businessId"),
  requireOwnerOnly,
  asyncHandler(async (req: Request, res) => {
    const doc = await createLocation(businessIdOf(req), requireObject(req.body, "body"));
    return sendSuccess(res, doc, 201);
  }),
);

// --------------------------------------------------------------- promotions

/** `GET /api/business/:businessId/promotions` */
router.get(
  "/:businessId/promotions",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listPromotions(businessIdOf(req)));
  }),
);

/**
 * `POST /api/business/:businessId/promotions`
 *
 * `redemptionCount` is server-owned — it increments when a booking actually uses
 * the promotion, never when it is created.
 */
router.post(
  "/:businessId/promotions",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    const doc = await addPromotion(
      currentUser(req).id,
      businessIdOf(req),
      requireObject(req.body, "body"),
    );
    return sendSuccess(res, doc, 201);
  }),
);

/** `PATCH /api/business/:businessId/promotions/:id` — pause/resume/raise the cap. */
router.patch(
  "/:businessId/promotions/:id",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await updatePromotion(
        businessIdOf(req),
        requireString(req.params.id, "id"),
        requireObject(req.body, "body"),
      ),
    );
  }),
);

/** `GET /api/business/:businessId/promotions/last-minute` — the active quiet-hour deal. */
router.get(
  "/:businessId/promotions/last-minute",
  requireBusinessAccess(":businessId"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await getLastMinutePromotion(businessIdOf(req)));
  }),
);

// ------------------------------------------------------------------ finance

/** `GET /api/business/:businessId/payments` — financial detail, permission-gated. */
router.get(
  "/:businessId/payments",
  requireBusinessAccess(":businessId"),
  requirePermission("viewFinancials"),
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const { docs, total } = await listPayments(businessIdOf(req), page, {
      status: queryString(req, "status") ?? undefined,
      from: queryString(req, "from") ?? undefined,
    });
    return sendSuccess(res, paginate(docs, total, page));
  }),
);

/**
 * `POST /api/business/:businessId/refunds`
 *
 * Needs `processRefunds`. A stylist holding only `manageCalendar` gets a 403
 * here even though they can mark their own appointment attended.
 */
router.post(
  "/:businessId/refunds",
  requireBusinessAccess(":businessId"),
  requirePermission("processRefunds"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await issueRefund(businessIdOf(req), requireObject(req.body, "body")));
  }),
);

/** `GET /api/business/:businessId/payouts` — settlement history. */
router.get(
  "/:businessId/payouts",
  requireBusinessAccess(":businessId"),
  requirePermission("viewFinancials"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listPayouts(businessIdOf(req)));
  }),
);

// ----------------------------------------------------------------- disputes

/** `GET /api/business/:businessId/disputes` — disputes raised against the business. */
router.get(
  "/:businessId/disputes",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listDisputes(businessIdOf(req)));
  }),
);

/** `POST /api/business/:businessId/disputes/:id/respond` — adds evidence to the timeline. */
router.post(
  "/:businessId/disputes/:id/respond",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(
      res,
      await respondToDispute(
        currentUser(req).id,
        businessIdOf(req),
        requireString(req.params.id, "id"),
        requireObject(req.body, "body"),
      ),
    );
  }),
);

// ------------------------------------------------------------------ reviews

/** `GET /api/business/:businessId/reviews` */
router.get(
  "/:businessId/reviews",
  requireBusinessAccess(":businessId"),
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const { docs, total } = await listBusinessReviews(
      businessIdOf(req),
      page,
      queryString(req, "status") ?? undefined,
    );
    return sendSuccess(res, paginate(docs.map((doc) => serializeReview(doc)), total, page));
  }),
);

// ------------------------------------------------------------ trust & scores

/**
 * `POST /api/business/:businessId/score/recompute`
 *
 * On-demand recompute. The same function runs nightly; badges and score are
 * still server-owned regardless of who triggers it.
 */
router.post(
  "/:businessId/score/recompute",
  requireBusinessAccess(":businessId"),
  requireOwnerOnly,
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await recomputeScoreAndBadges(businessIdOf(req)));
  }),
);

/** `POST /api/business/:businessId/insights/recompute` — owner-triggered CRM refresh. */
router.post(
  "/:businessId/insights/recompute",
  requireBusinessAccess(":businessId"),
  requirePermission("viewCustomerData"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await recomputeInsights(businessIdOf(req)));
  }),
);

// ---------------------------------------------------------------- portfolio

/** `GET /api/business/:businessId/portfolio` — before/after work. */
router.get(
  "/:businessId/portfolio",
  requireBusinessAccess(":businessId"),
  asyncHandler(async (req: Request, res) => {
    return sendSuccess(res, await listPortfolio(businessIdOf(req), gate(req)));
  }),
);

/** `POST /api/business/:businessId/portfolio` — owner/manager publishes a look. */
router.post(
  "/:businessId/portfolio",
  requireBusinessAccess(":businessId"),
  requireStaffManagement,
  asyncHandler(async (req: Request, res) => {
    const doc = await addPortfolioItem(businessIdOf(req), requireObject(req.body, "body"));
    return sendSuccess(res, doc, 201);
  }),
);

// -------------------------------------------------------------- audit trail

/**
 * `GET /api/business/:businessId/audit-logs`
 *
 * Admin actions that touched this business. Read-only for the business, and
 * written exclusively by the admin module.
 */
router.get(
  "/:businessId/audit-logs",
  requireBusinessAccess(":businessId"),
  requireOwnerOnly,
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const { docs, total } = await listBusinessAuditLogs(businessIdOf(req), page);
    return sendSuccess(res, paginate(docs, total, page));
  }),
);

export default router;
