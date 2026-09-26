import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { getCollection } from "../../shared/db";
import { requireObject, requireString } from "../../shared/utils";
import type { BookingDoc, StaffDoc } from "../../types/domain";
import { BookingStatus } from "../../types/enums";
import { computeAvailability } from "../../services/availability.service";
import { changeBookingStatus } from "../../services/booking.service";
import { sendNotification } from "../../services/notification.service";

/**
 * The stylist/manager surface.
 *
 * This is deliberately a separate module from `business`: every function here is
 * about *the signed-in staff member's own* work. The business id is resolved
 * from the caller's `Staff` row rather than taken from a URL parameter, and every
 * booking is re-checked against `staff._id` before it is touched. There is no
 * code path here that can act on a colleague's appointment.
 */

/**
 * The caller's own staff row. A missing or inactive row is a 403 rather than a
 * 404, because the caller *is* authenticated — they simply have no staff profile.
 */
export async function requireOwnStaff(userId: string): Promise<StaffDoc> {
  const staff = await getCollection<StaffDoc>(Collections.staff).findOne({ userId });
  if (!staff) throw ApiError.forbidden("No active staff record is linked to your account");
  if (staff.status !== "active") throw ApiError.forbidden(`Your staff account is ${staff.status}`);
  return staff;
}

/** The caller's profile as they should see it, including their own permissions. */
export function describeOwnStaff(staff: StaffDoc): Record<string, unknown> {
  return {
    _id: staff._id,
    businessId: staff.businessId,
    displayName: staff.displayName,
    title: staff.title ?? null,
    role: staff.role,
    avatarUrl: staff.avatarUrl ?? null,
    bio: staff.bio ?? null,
    bookable: staff.bookable === true,
    workingHours: staff.workingHours ?? {},
    locationIds: staff.locationIds ?? [],
    serviceIds: staff.serviceIds ?? [],
    commission: staff.commission ?? { type: "none", value: 0 },
    ratingSummary: staff.ratingSummary ?? { average: 0, count: 0 },
    permissions: staff.permissions,
  };
}

/** Loads one of the caller's own bookings, or reports it as not found. */
async function ownBooking(staff: StaffDoc, bookingId: string): Promise<BookingDoc> {
  const booking = await getCollection<BookingDoc>(Collections.bookings).findOne({ _id: bookingId });
  // A booking that exists but belongs to someone else is reported as not found,
  // so this endpoint cannot be used to probe for other businesses' booking ids.
  if (!booking || booking.staffId !== staff._id) {
    throw ApiError.notFound("Booking not found");
  }
  return booking;
}

export interface StaffScheduleQuery {
  page: number;
  pageSize: number;
  status?: string;
  from?: string;
  to?: string;
}

export async function listOwnSchedule(
  staff: StaffDoc,
  query: StaffScheduleQuery,
): Promise<{ docs: BookingDoc[]; total: number }> {
  const filter: Record<string, unknown> = { staffId: staff._id, businessId: staff.businessId };
  if (query.status) filter.status = query.status;
  if (query.from) filter.startAt = { $gte: query.from };
  if (query.to) filter.startAt = { ...(filter.startAt as object), $lte: query.to };

  const collection = getCollection<BookingDoc>(Collections.bookings);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ startAt: 1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs, total };
}

/** The day's list, the view a stylist actually opens at the start of a shift. */
export async function listToday(staff: StaffDoc): Promise<{ date: string; bookings: BookingDoc[] }> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3_600_000);

  const bookings = await getCollection<BookingDoc>(Collections.bookings)
    .find({
      staffId: staff._id,
      businessId: staff.businessId,
      startAt: { $gte: start.toISOString(), $lt: end.toISOString() },
    })
    .sort({ startAt: 1 })
    .toArray();

  return { date: start.toISOString().slice(0, 10), bookings };
}

/**
 * Marks the stylist's own appointment attended. `changeBookingStatus` owns the
 * transition rules and the deposit consequences, so this cannot skip them.
 */
export async function completeBooking(
  userId: string,
  bookingId: string,
): Promise<{ booking: BookingDoc; outcome: unknown }> {
  const staff = await requireOwnStaff(userId);
  await ownBooking(staff, bookingId);
  return changeBookingStatus(bookingId, BookingStatus.ATTENDED, userId, null, { via: "business" });
}

/** Marks the stylist's own appointment as a customer no-show. */
export async function markNoShow(
  userId: string,
  bookingId: string,
  body: Record<string, unknown>,
): Promise<{ booking: BookingDoc; outcome: unknown }> {
  const staff = await requireOwnStaff(userId);
  await ownBooking(staff, bookingId);
  return changeBookingStatus(
    bookingId,
    BookingStatus.NO_SHOW,
    userId,
    typeof body.reason === "string" ? body.reason : null,
    { via: "business" },
  );
}

/** The stylist's own bookable slots. A stylist can see their week, not a colleague's. */
export async function ownAvailability(
  staff: StaffDoc,
  serviceId: string,
  days: number,
): Promise<unknown> {
  const dateFrom = new Date();
  return computeAvailability({
    businessId: staff.businessId,
    serviceId,
    staffId: staff._id,
    dateFrom,
    dateTo: new Date(dateFrom.getTime() + days * 86_400_000),
    fromCoordinates: null,
  });
}

/**
 * Customers the stylist has actually worked with. Gated on `viewCustomerData`, so
 * a stylist without it gets a 403 rather than an empty list that looks like
 * "you have no customers".
 */
export async function ownCustomers(staff: StaffDoc): Promise<Record<string, unknown>[]> {
  if (staff.permissions?.viewCustomerData !== true) {
    throw ApiError.forbidden("Your staff role does not include customer data access");
  }

  const bookings = await getCollection<BookingDoc>(Collections.bookings)
    .find({ staffId: staff._id }, { projection: { customerUserId: 1 } })
    .toArray();
  const userIds = [...new Set(bookings.map((booking) => booking.customerUserId))];

  const customers = await getCollection(Collections.customers)
    .find({ businessId: staff.businessId, userId: { $in: userIds } })
    .sort({ updatedAt: -1 })
    .limit(200)
    .toArray();
  return customers as Record<string, unknown>[];
}

/** The stylist's own numbers, subject to `viewFinancials`. */
export async function ownPerformance(staff: StaffDoc): Promise<Record<string, unknown>> {
  if (staff.permissions?.viewFinancials !== true) {
    throw ApiError.forbidden("Your staff role does not include financial reporting");
  }

  const bookings = await getCollection<BookingDoc>(Collections.bookings)
    .find({ staffId: staff._id, businessId: staff.businessId, status: BookingStatus.ATTENDED })
    .toArray();

  return {
    appointments: bookings.length,
    revenueMinor: bookings.reduce((sum, booking) => sum + booking.pricing.totalMinor, 0),
    commission: staff.commission ?? { type: "none", value: 0 },
    ratingSummary: staff.ratingSummary ?? { average: 0, count: 0 },
  };
}

/** Threads for the staff member's own business. */
export async function listBusinessConversations(
  userId: string,
  claimedBusinessId: string,
): Promise<Record<string, unknown>[]> {
  const staff = await requireOwnStaff(userId);
  if (claimedBusinessId !== staff.businessId) {
    throw ApiError.forbidden("That business does not match your staff record");
  }
  const conversations = await getCollection(Collections.conversations)
    .find({ businessId: staff.businessId })
    .sort({ updatedAt: -1 })
    .limit(100)
    .toArray();
  return conversations as Record<string, unknown>[];
}

/**
 * Reminds the customer they are coming today. Rate limited by refusing a second
 * reminder for the same booking within 12 hours, so the button cannot be used to
 * spam a customer.
 */
export async function nudgeCustomer(userId: string, bookingId: string): Promise<Record<string, unknown>> {
  const staff = await requireOwnStaff(userId);
  const booking = await ownBooking(staff, bookingId);

  const recent = await getCollection(Collections.notifications).countDocuments({
    userId: booking.customerUserId,
    type: "appointment_reminder",
    "data.bookingId": booking._id,
    createdAt: { $gte: new Date(Date.now() - 12 * 3_600_000).toISOString() },
  });
  if (recent > 0) {
    throw ApiError.conflict("You already reminded them about this appointment");
  }

  const notification = await sendNotification({
    userId: booking.customerUserId,
    type: "appointment_reminder",
    title: "Your appointment is coming up",
    body: `See you ${booking.startAt} with ${staff.displayName}.`,
    data: { bookingId: booking._id, businessId: staff.businessId, staffId: staff._id },
  });
  return notification as Record<string, unknown>;
}

export { requireObject, requireString };
