import { Filter, ObjectId } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated, serialize } from "../../shared/helpers";
import { populateMany } from "../../shared/populate";
import {
  optionalEnum,
  optionalId,
  optionalNumber,
  optionalRecord,
  requireDate,
  requireId,
  requireNumber,
  toObjectId,
} from "../../shared/validate";
import { BookingStatus, PaymentMethod, Role } from "../../types/enums";
import { ActorContext, resolveActor } from "../../shared/identify.middleware";
import { COLLECTIONS, getCollection } from "../../shared/db";
import { findCustomerIdByFirebaseUid } from "../users/users";
import { IService } from "../services/model";
import { BLOCKING_STATUSES, BookingModel, IBooking } from "./model";

/** Refs resolved onto every booking response. */
const BOOKING_POPULATE = [
  {
    field: "serviceId",
    collection: COLLECTIONS.SERVICES,
    select: ["name", "category", "price", "durationMinutes"],
  },
  {
    field: "businessId",
    collection: COLLECTIONS.BUSINESSES,
    select: ["businessName", "category", "location"],
  },
  {
    field: "customerId",
    collection: COLLECTIONS.USERS,
    select: ["name", "email", "phone"],
  },
  {
    field: "staffId",
    collection: COLLECTIONS.STAFF,
    select: ["name", "permissionLevel"],
  },
];

async function present(docs: IBooking[]): Promise<Record<string, unknown>[]> {
  return populateMany(docs, BOOKING_POPULATE);
}

/**
 * POST /api/bookings — customer creates a booking.
 *
 * The service decides the duration and the price; the client only supplies the
 * business, the service, a start time and optionally a staff member. endTime is
 * computed server-side so a client can never book a slot that is longer or shorter
 * than the service actually is.
 */
export async function createBooking(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const actor = await resolveActor({ firebaseUid }, findCustomerIdByFirebaseUid);
  if (!actor.customerId) {
    throw ApiError.forbidden("Only customers can create bookings");
  }

  const serviceId = requireId(body, "serviceId");
  const startTime = requireDate(body, "startTime");
  const staffId = optionalId(body, "staffId");
  const consultationForm = optionalRecord(body, "consultationForm");
  const paymentMethod = optionalEnum(body, "paymentMethod", PaymentMethod);
  const depositAmount = optionalNumber(body, "depositAmount", { min: 0 });

  if (startTime.getTime() <= Date.now()) {
    throw ApiError.badRequest('"startTime" must be in the future');
  }

  const bookings = BookingModel();

  const service = await getCollection<IService>(COLLECTIONS.SERVICES).findOne({ _id: serviceId });

  if (!service) throw ApiError.notFound("Service not found");
  if (!service.isActive) throw ApiError.badRequest("That service is no longer available");

  // The business is taken from the service, so a client cannot book service X at a
  // different business Y.
  const businessId = service.businessId as ObjectId;

  const endTime = new Date(startTime.getTime() + service.durationMinutes * 60_000);

  if (staffId) {
    const clash = await bookings.findOne(
      {
        staffId,
        status: { $in: BLOCKING_STATUSES },
        // Half-open overlap: an existing booking [s, e) collides when s < end && e > start.
        startTime: { $lt: endTime },
        endTime: { $gt: startTime },
      },
      { projection: { _id: 1, startTime: 1, endTime: 1, status: 1 } }
    );

    if (clash) {
      throw ApiError.conflict(
        "That staff member is already booked for an overlapping time slot",
        {
          conflictingBookingId: (clash as IBooking)._id.toHexString(),
          startTime: (clash as IBooking).startTime,
          endTime: (clash as IBooking).endTime,
        }
      );
    }
  }

  const now = new Date();
  const document = {
    customerId: new ObjectId(actor.customerId),
    businessId,
    staffId,
    serviceId,
    startTime,
    endTime,
    status: BookingStatus.PENDING,
    depositAmount: depositAmount ?? 0,
    totalPrice: service.price,
    amountPaid: 0,
    tip: 0,
    paymentMethod,
    consultationForm,
    isVerifiedReviewEligible: false,
    createdAt: now,
    updatedAt: now,
  };

  const result = await bookings.insertOne(document);
  const [created] = await present([(await bookings.findOne({ _id: result.insertedId })) as IBooking]);

  return sendSuccess(res, 201, "Booking created", { booking: created });
}

/**
 * GET /api/bookings — the same route serves every role.
 * Scope is derived from the caller's credential; admins may inspect everything.
 */
export async function listBookings(
  query: Record<string, unknown>,
  res: Response,
  actor: ActorContext
) {
  const pagination = getPagination(query);
  const bookings = BookingModel();
  const filter: Filter<IBooking> = {};

  if (actor.isAdmin) {
    if (typeof query.businessId === "string" && query.businessId) {
      filter.businessId = toObjectId(query.businessId, "business id");
    }
  } else if (actor.isCustomer) {
    filter.customerId = toObjectId(actor.customerId as string, "customer id");
  } else if (actor.role === Role.STAFF) {
    filter.staffId = toObjectId(actor.staffId as string, "staff id");
  } else {
    filter.businessId = toObjectId(actor.businessId as string, "business id");
  }

  if (typeof query.status === "string" && query.status) {
    if (!Object.values(BookingStatus).includes(query.status as BookingStatus)) {
      throw ApiError.badRequest('"status" filter is not a valid booking status', {
        allowed: Object.values(BookingStatus),
      });
    }
    filter.status = query.status as BookingStatus;
  }

  const [docs, total] = await Promise.all([
    bookings.find(filter).sort({ startTime: -1 }).skip(pagination.skip).limit(pagination.limit).toArray(),
    bookings.countDocuments(filter),
  ]);

  return sendPaginated(res, "Bookings retrieved", await present(docs), total, pagination);
}

/** GET /api/bookings/:id — visible to the customer, the business side, or an admin. */
export async function getBooking(
  params: Record<string, string>,
  res: Response,
  actor: ActorContext
) {
  const booking = await requireVisibleBooking(params.id, actor);
  const [item] = await present([booking]);
  return sendSuccess(res, 200, "Booking retrieved", { booking: item });
}

/**
 * PATCH /api/bookings/:id/status
 *
 * The business side may move a booking to any status. A customer may only withdraw
 * their own booking (cancelled / late_cancel / no_show) — the middleware is
 * identifyAny, so without this narrowing a customer could mark their own visit as
 * `attended` and unlock a review for an appointment that never happened.
 *
 * Reaching `attended` always sets isVerifiedReviewEligible, which is what
 * POST /api/reviews checks before accepting a review.
 */
export async function updateBookingStatus(
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response,
  actor: ActorContext
) {
  const booking = await requireVisibleBooking(params.id, actor);

  const status = optionalEnum(body, "status", BookingStatus);
  if (!status) {
    throw ApiError.badRequest('"status" is required', { allowed: Object.values(BookingStatus) });
  }

  if (actor.isCustomer) {
    assertCustomerMayCancel(booking, actor);
    if (
      status !== BookingStatus.CANCELLED &&
      status !== BookingStatus.LATE_CANCEL &&
      status !== BookingStatus.NO_SHOW
    ) {
      throw ApiError.forbidden(
        "Customers may only cancel or mark a no-show. Other status changes are made by the business."
      );
    }
  } else {
    assertBusinessSide(booking, actor);
  }

  const update: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === BookingStatus.ATTENDED) {
    update.isVerifiedReviewEligible = true;
  }

  await BookingModel().updateOne({ _id: booking._id }, { $set: update });
  const updated = (await BookingModel().findOne({ _id: booking._id })) as IBooking;
  const [item] = await present([updated]);

  return sendSuccess(res, 200, `Booking status set to "${status}"`, { booking: item });
}

/**
 * PATCH /api/bookings/:id/checkout
 *
 * Records payment taken at the appointment. If the booking has not happened yet,
 * checking out implies the customer showed up, so the status auto-transitions to
 * `attended` and the booking becomes review-eligible in the same write.
 *
 * Business side only: a customer has no business recording what they paid.
 */
export async function checkoutBooking(
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response,
  actor: ActorContext
) {
  const booking = await requireVisibleBooking(params.id, actor);
  if (actor.isCustomer) {
    throw ApiError.forbidden("Only the business can record a checkout");
  }
  assertBusinessSide(booking, actor);

  const amountPaid = optionalNumber(body, "amountPaid", { min: 0 });
  const tip = optionalNumber(body, "tip", { min: 0 });
  const paymentMethod = optionalEnum(body, "paymentMethod", PaymentMethod);

  const wasUpcoming =
    booking.status === BookingStatus.PENDING || booking.status === BookingStatus.CONFIRMED;

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (amountPaid !== undefined) {
    update.amountPaid = amountPaid;
  } else if (wasUpcoming) {
    // A checkout with no stated amount means the customer settled the full price.
    update.amountPaid = booking.totalPrice;
  }
  if (tip !== undefined) update.tip = tip;
  if (paymentMethod !== undefined) update.paymentMethod = paymentMethod;

  if (wasUpcoming) {
    update.status = BookingStatus.ATTENDED;
    update.isVerifiedReviewEligible = true;
  }

  await BookingModel().updateOne({ _id: booking._id }, { $set: update });
  const updated = (await BookingModel().findOne({ _id: booking._id })) as IBooking;
  const [item] = await present([updated]);

  return sendSuccess(res, 200, "Booking checked out", { booking: item });
}

/* ------------------------------------------------------------------ helpers */

async function requireVisibleBooking(id: string, actor: ActorContext): Promise<IBooking> {
  const booking = await BookingModel().findOne({ _id: toObjectId(id, "booking id") });
  if (!booking) throw ApiError.notFound("Booking not found");

  const typed = booking as IBooking;
  const customerId = typed.customerId.toHexString();
  const businessId = typed.businessId.toHexString();
  const staffId = typed.staffId ? typed.staffId.toHexString() : null;

  if (actor.isAdmin) return typed;

  if (actor.isCustomer) {
    if (customerId !== actor.customerId) {
      throw ApiError.forbidden("You can only view your own bookings");
    }
    return typed;
  }

  if (businessId !== actor.businessId) {
    throw ApiError.forbidden("That booking belongs to another business");
  }
  // Staff can only act on bookings assigned to them.
  if (actor.role === Role.STAFF && staffId !== actor.staffId) {
    throw ApiError.forbidden("You can only act on bookings assigned to you");
  }
  return typed;
}

function assertBusinessSide(booking: IBooking, actor: ActorContext): void {
  if (actor.isAdmin) return;
  if (booking.businessId.toHexString() !== actor.businessId) {
    throw ApiError.forbidden("That booking belongs to another business");
  }
  if (
    actor.role === Role.STAFF &&
    (!booking.staffId || booking.staffId.toHexString() !== actor.staffId)
  ) {
    throw ApiError.forbidden("You can only act on bookings assigned to you");
  }
}

function assertCustomerMayCancel(booking: IBooking, actor: ActorContext): void {
  if (booking.customerId.toHexString() !== actor.customerId) {
    throw ApiError.forbidden("You can only change your own bookings");
  }
  if (booking.status === BookingStatus.ATTENDED) {
    throw ApiError.badRequest("An attended booking can no longer be cancelled");
  }
}

export default {
  createBooking,
  listBookings,
  getBooking,
  updateBookingStatus,
  checkoutBooking,
};
