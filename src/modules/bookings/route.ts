import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireFirebaseUser } from "../../shared/firebase.middleware";
import { identifyAny, resolveActor } from "../../shared/identify.middleware";
import { ApiError } from "../../shared/apiError";
import { findCustomerIdByFirebaseUid } from "../users/users";
import {
  checkoutBooking,
  createBooking,
  getBooking,
  listBookings,
  updateBookingStatus,
} from "./bookings";

const router = Router();

/** POST /api/bookings — customer only (Firebase). */
router.post(
  "/",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    createBooking(req.firebaseUid, req.body as Record<string, unknown>, res)
  )
);

/**
 * GET /api/bookings — one route, four scopes.
 * customer -> own bookings, owner -> business bookings, staff -> own assignments,
 * admin -> everything.
 */
router.get(
  "/",
  identifyAny,
  asyncHandler(async (req, res) => {
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return listBookings(req.query as Record<string, unknown>, res, actor);
  })
);

/** GET /api/bookings/:id */
router.get(
  "/:id",
  identifyAny,
  asyncHandler(async (req, res) => {
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return getBooking(req.params as Record<string, string>, res, actor);
  })
);

/** PATCH /api/bookings/:id/status */
router.patch(
  "/:id/status",
  identifyAny,
  asyncHandler(async (req, res) => {
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return updateBookingStatus(
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res,
      actor
    );
  })
);

/** PATCH /api/bookings/:id/checkout */
router.patch(
  "/:id/checkout",
  identifyAny,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized("A business token is required to check out");
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return checkoutBooking(
      req.params as Record<string, string>,
      req.body as Record<string, unknown>,
      res,
      actor
    );
  })
);

export default router;
