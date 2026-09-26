import { Router, type Request } from "express";
import { asyncHandler } from "../../middleware/error";
import { currentUser, requireAuth, requireOwnResource, requireRole } from "../../auth/middleware";
import {
  redactionContext,
  serializeBooking,
  serializeCustomerRecord,
  serializeReview,
  serializeWallet,
} from "../../serializers";
import { sendSuccess } from "../../shared/response";
import { queryInt } from "../../shared/utils";
import { config } from "../../shared/config";
import { UserRole } from "../../types/enums";
import * as customer from "./customer";

/**
 * `/api/customer` — HTTP surface only. All rules live in `customer.ts`.
 */
const router = Router();

/** Every route here requires a signed-in account; there is no guest checkout. */
router.use(requireAuth);

const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
const query = (req: Request): Record<string, unknown> => req.query as Record<string, unknown>;

const paging = (req: Request, defaultPageSize = 20): customer.Paging => ({
  page: queryInt(query(req), "page", 1, 1, 10_000),
  pageSize: queryInt(query(req), "pageSize", defaultPageSize, 1, 100),
});

const str = (req: Request, key: string): string | undefined =>
  typeof query(req)[key] === "string" ? (query(req)[key] as string) : undefined;

// ---------------------------------------------------------------- discover

/** `GET /api/customer/search` */
router.get(
  "/search",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.runSearch(currentUser(req).id, query(req))),
  ),
);

/** `GET /api/customer/availability` */
router.get(
  "/availability",
  asyncHandler(async (req: Request, res) => {
    const q = query(req);
    return sendSuccess(
      res,
      await customer.getAvailability({
        businessId: String(q.businessId),
        serviceId: String(q.serviceId),
        days: queryInt(q, "days", config.availability.defaultHorizonDays, 1, 60),
        ...(str(req, "locationId") ? { locationId: str(req, "locationId") } : {}),
        ...(str(req, "staffId") ? { staffId: str(req, "staffId") } : {}),
        ...(str(req, "date") ? { date: str(req, "date") } : {}),
        ...(q.coordinates !== undefined ? { coordinates: q.coordinates } : {}),
      }),
    );
  }),
);

/** `GET /api/customer/businesses/:businessId` */
router.get(
  "/businesses/:businessId",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.getBusinessForCustomer(String(req.params.businessId))),
  ),
);

/** `GET /api/customer/services/:serviceId` */
router.get(
  "/services/:serviceId",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.getService(String(req.params.serviceId))),
  ),
);

// ---------------------------------------------------------------- bookings

/** `POST /api/customer/bookings` */
router.post(
  "/bookings",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const result = await customer.book(currentUser(req).id, body(req));
    const ctx = redactionContext(req);
    return sendSuccess(
      res,
      { booking: serializeBooking(result.booking, ctx), policyAccepted: result.policy },
      201,
    );
  }),
);

/** `GET /api/customer/bookings` */
router.get(
  "/bookings",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const result = await customer.listBookings(currentUser(req).id, page, {
      ...(str(req, "status") ? { status: str(req, "status") } : {}),
      ...(str(req, "scope") ? { scope: str(req, "scope") } : {}),
    });
    const ctx = redactionContext(req);
    return sendSuccess(
      res,
      customer.paginate(result.docs.map((doc) => serializeBooking(doc, ctx)), result.total, page),
    );
  }),
);

/** `GET /api/customer/bookings/:id` */
router.get(
  "/bookings/:id",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeBooking(
        await customer.getOwnBooking(currentUser(req).id, String(req.params.id)),
        redactionContext(req),
      ),
    ),
  ),
);

/** `POST /api/customer/bookings/:id/cancel` */
router.post(
  "/bookings/:id/cancel",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const result = await customer.cancelBooking(currentUser(req).id, String(req.params.id), body(req));
    return sendSuccess(res, {
      booking: serializeBooking(result.booking, redactionContext(req)),
      depositOutcome: result.outcome,
      instantSlotPublished: result.instantSlotId !== null,
    });
  }),
);

/** `POST /api/customer/bookings/:id/reschedule` */
router.post(
  "/bookings/:id/reschedule",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const result = await customer.rescheduleOwnBooking(
      currentUser(req).id,
      String(req.params.id),
      body(req),
    );
    return sendSuccess(res, {
      booking: serializeBooking(result.booking, redactionContext(req)),
      previous: result.previous,
    });
  }),
);

/** `POST /api/customer/bookings/:id/no-show` */
router.post(
  "/bookings/:id/no-show",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const result = await customer.declareNoShow(currentUser(req).id, String(req.params.id));
    return sendSuccess(res, {
      booking: serializeBooking(result.booking, redactionContext(req)),
      depositOutcome: result.outcome,
    });
  }),
);

// ---------------------------------------------------------------- payments

/** `POST /api/customer/bookings/:id/payments` */
router.post(
  "/bookings/:id/payments",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.pay(currentUser(req).id, String(req.params.id), body(req))),
  ),
);

/** `GET /api/customer/wallet` */
router.get(
  "/wallet",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeWallet(
        (await customer.getOrCreateWallet(currentUser(req).id)) as unknown as Record<string, unknown>,
        redactionContext(req),
      ),
    ),
  ),
);

/** `GET /api/customer/wallet/transactions` */
router.get(
  "/wallet/transactions",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const page = paging(req, 25);
    const result = await customer.listWalletTransactions(currentUser(req).id, page);
    return sendSuccess(res, customer.paginate(result.docs, result.total, page));
  }),
);

// ---------------------------------------------------------------- reviews

/** `POST /api/customer/bookings/:id/review` */
router.post(
  "/bookings/:id/review",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeReview(await customer.writeReview(currentUser(req).id, String(req.params.id), body(req))),
      201,
    ),
  ),
);

/** `GET /api/customer/reviews` */
router.get(
  "/reviews",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const page = paging(req);
    const result = await customer.listOwnReviews(currentUser(req).id, page);
    return sendSuccess(res, customer.paginate(result.docs.map(serializeReview), result.total, page));
  }),
);

/** `POST /api/customer/reviews/:id/reply` — a business replying to its own review thread. */
router.post(
  "/reviews/:id/reply",
  requireRole(UserRole.BUSINESS_OWNER),
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeReview(
        await customer.replyToOwnBusinessReview(currentUser(req).id, String(req.params.id), body(req)),
      ),
    ),
  ),
);

// ---------------------------------------------------------------- waitlist

/** `POST /api/customer/waitlist` */
router.post(
  "/waitlist",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.joinQueue(currentUser(req).id, body(req)), 201),
  ),
);

/** `GET /api/customer/waitlist` */
router.get(
  "/waitlist",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const docs = await customer.listOwnWaitlist(currentUser(req).id);
    return sendSuccess(res, customer.paginate(docs, docs.length, { page: 1, pageSize: docs.length || 1 }));
  }),
);

// ------------------------------------------------------- instant booking

/** `GET /api/customer/instant-slots` */
router.get(
  "/instant-slots",
  asyncHandler(async (req: Request, res) => {
    const docs = await customer.listOpenInstantSlots({
      ...(str(req, "businessId") ? { businessId: str(req, "businessId") } : {}),
      ...(str(req, "serviceId") ? { serviceId: str(req, "serviceId") } : {}),
    });
    return sendSuccess(res, customer.paginate(docs, docs.length, { page: 1, pageSize: 50 }));
  }),
);

/** `POST /api/customer/instant-slots/:id/book` */
router.post(
  "/instant-slots/:id/book",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeBooking(
        await customer.bookInstantSlot(currentUser(req).id, String(req.params.id)),
        redactionContext(req),
      ),
      201,
    ),
  ),
);

// ---------------------------------------------------------------- rebooking

/** `GET /api/customer/rebooking/prompts` */
router.get(
  "/rebooking/prompts",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.getRebookingPrompts(currentUser(req).id)),
  ),
);

/** `POST /api/customer/rebooking/prompts/:id/accept` */
router.post(
  "/rebooking/prompts/:id/accept",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.acceptPrompt(currentUser(req).id, String(req.params.id))),
  ),
);

// ---------------------------------------------------------------- CRM read

/** `GET /api/customer/me/profile` */
router.get(
  "/me/profile",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeCustomerRecord(
        (await customer.getOwnCustomerRecord(
          currentUser(req).id,
          String(query(req).businessId),
        )) as unknown as Record<string, unknown>,
        redactionContext(req),
      ),
    ),
  ),
);

/** `PATCH /api/customer/me/profile` */
router.patch(
  "/me/profile",
  requireOwnResource,
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      serializeCustomerRecord(
        (await customer.updateOwnCustomerRecord(
          currentUser(req).id,
          body(req),
        )) as unknown as Record<string, unknown>,
        redactionContext(req),
      ),
    ),
  ),
);

// ---------------------------------------------------------------- favourites

/** `POST /api/customer/favourites` */
router.post(
  "/favourites",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const result = await customer.toggleFavourite(currentUser(req).id, body(req));
    return sendSuccess(res, result, result.favourited ? 201 : 200);
  }),
);

/** `GET /api/customer/favourites` */
router.get(
  "/favourites",
  requireOwnResource,
  asyncHandler(async (req: Request, res) => {
    const docs = await customer.listFavourites(currentUser(req).id);
    return sendSuccess(res, customer.paginate(docs, docs.length, { page: 1, pageSize: docs.length || 1 }));
  }),
);

// ---------------------------------------------------------------- notifications

/** `GET /api/customer/notifications` */
router.get(
  "/notifications",
  asyncHandler(async (req: Request, res) => {
    const page = paging(req, 25);
    const result = await customer.listNotifications(currentUser(req).id, page);
    return sendSuccess(res, customer.paginate(result.docs, result.total, page));
  }),
);

/** `POST /api/customer/notifications/:id/read` */
router.post(
  "/notifications/:id/read",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.markNotificationRead(currentUser(req).id, String(req.params.id))),
  ),
);

/** `POST /api/customer/notifications/read-all` */
router.post(
  "/notifications/read-all",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.markAllNotificationsRead(currentUser(req).id)),
  ),
);

// ---------------------------------------------------------------- devices

/** `POST /api/customer/devices` */
router.post(
  "/devices",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.registerDevice(currentUser(req).id, body(req)), 201),
  ),
);

/** `DELETE /api/customer/devices` */
router.delete(
  "/devices",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await customer.unregisterDevice(currentUser(req).id, body(req))),
  ),
);

export default router;
