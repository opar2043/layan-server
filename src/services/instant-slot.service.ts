import { Collections } from "../shared/collections";
import { asUpdate, getCollection } from "../shared/db";
import { config } from "../shared/config";
import { ApiError } from "../shared/errors";
import { generateId, isoNow, toDate } from "../shared/utils";
import type {
  BookingDoc,
  InstantSlotDoc,
  PromotionDoc,
  ServiceDoc,
  StaffDoc,
} from "../types/domain";
import { findBusinessLastMinutePromotion, applyDiscount } from "./promotion.service";
import { sendNotification } from "./notification.service";

/**
 * Turns a cancellation into a discounted open slot.
 *
 * Called automatically from the booking state machine when a booking is cancelled
 * within the configured window, and directly by
 * `POST /api/business/bookings/:id/publish-as-instant-slot`.
 */
export async function publishInstantSlotForCancellation(
  booking: BookingDoc,
  options: { auto: boolean; actorId: string },
): Promise<string | null> {
  const businessId = booking.businessId;
  const serviceId = booking.items[0]?.serviceId;
  if (!serviceId) return null;
  const service = await getCollection<ServiceDoc>(Collections.services).findOne({
    _id: serviceId,
  });
  if (!service) return null;

  const staff = await getCollection<StaffDoc>(Collections.staff).findOne({
    _id: booking.staffId,
  });
  if (!staff || staff.bookable !== true) return null;

  // An open slot for the same staff/time may already exist.
  const existing = await getCollection<InstantSlotDoc>(Collections.instantSlots).findOne({
    businessId,
    staffId: booking.staffId,
    startAt: booking.startAt,
    status: "open",
  });
  if (existing) return existing._id;

  const promotion = await findBusinessLastMinutePromotion(businessId);
  const originalPriceMinor = booking.pricing.subtotalMinor;
  const discountedPriceMinor = promotion
    ? Math.max(0, originalPriceMinor - applyDiscount(originalPriceMinor, promotion.discount))
    : originalPriceMinor;

  const startAt = new Date(booking.startAt);
  // The slot expires a little before the appointment so nobody books into the past.
  const expiresAt = new Date(
    Math.min(
      startAt.getTime() - 30 * 60_000,
      Date.now() + 12 * 60 * 60 * 1000,
    ),
  );
  if (expiresAt.getTime() <= Date.now()) return null;

  const at = isoNow();
  const doc: InstantSlotDoc = {
    _id: generateId("isl"),
    businessId,
    locationId: booking.locationId,
    staffId: booking.staffId,
    serviceId: service._id,
    originalBookingId: options.auto ? booking._id : null,
    startAt: startAt.toISOString(),
    endAt: booking.endAt,
    originalPriceMinor,
    discountedPriceMinor,
    promotionId: promotion?._id ?? null,
    autoPublished: options.auto,
    status: "open",
    bookedBookingId: null,
    publishedAt: at,
    expiresAt: expiresAt.toISOString(),
    createdAt: at,
    updatedAt: at,
  };

  await getCollection<InstantSlotDoc>(Collections.instantSlots).insertOne(doc);

  if (promotion) {
    await getCollection<PromotionDoc>(Collections.promotions).updateOne(
      { _id: promotion._id },
      asUpdate<PromotionDoc>({ $inc: { redemptionCount: 1 }, $set: { updatedAt: at } }),
    );
  }

  await notifyMatchingWaitlists(doc);
  return doc._id;
}

async function notifyMatchingWaitlists(slot: InstantSlotDoc): Promise<void> {
  const service = await getCollection<ServiceDoc>(Collections.services).findOne({
    _id: slot.serviceId,
  });
  if (!service) return;

  const waitlists = getCollection(Collections.waitlists);
  const candidates = await waitlists
    .find({ businessId: slot.businessId, serviceId: slot.serviceId, status: "active" })
    .toArray();

  const startMinutes = new Date(slot.startAt).getUTCHours() * 60 + new Date(slot.startAt).getUTCMinutes();
  const at = isoNow();

  for (const entry of candidates) {
    const ranges = Array.isArray(entry.preferredTimeRanges) ? entry.preferredTimeRanges : [];
    const inRange = ranges.some((range: unknown) => {
      if (!Array.isArray(range) || range.length < 2) return false;
      const [from, to] = range as [string, string];
      const fromMinutes = parseClock(from);
      const toMinutes = parseClock(to);
      return fromMinutes !== null && toMinutes !== null && startMinutes >= fromMinutes && startMinutes <= toMinutes;
    });
    if (!inRange) continue;

    await waitlists.updateOne(
      { _id: entry._id, status: "active" },
      { $set: { status: "notified", notifiedAt: at, instantSlotId: slot._id, updatedAt: at } },
    );
    await sendNotification({
      userId: String(entry.customerUserId),
      type: "waitlist_slot_available",
      title: "A slot just opened!",
      body: `${service.name} is now available at a discount.`,
      data: { instantSlotId: slot._id, waitlistId: entry._id },
    });
  }
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Expire open slots whose window has passed. Run by the nightly job. */
export async function expireStaleInstantSlots(): Promise<number> {
  const now = isoNow();
  const result = await getCollection<InstantSlotDoc>(Collections.instantSlots).updateMany(
    { status: "open", expiresAt: { $lte: now } },
    { $set: { status: "expired", updatedAt: now } },
  );
  return result.modifiedCount;
}

export function parseInstantSlotWindow(hours: number = config.availability.instantSlotWindowHours): number {
  return hours;
}

export function assertInstantSlotBookable(slot: Record<string, unknown>): void {
  if (slot.status !== "open") {
    throw ApiError.conflict("That instant slot is no longer open");
  }
  const expiresAt = toDate(slot.expiresAt, "expiresAt");
  if (expiresAt.getTime() <= Date.now()) {
    throw ApiError.conflict("That instant slot has expired");
  }
}
