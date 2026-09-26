import { Collections } from "../shared/collections";
import { asUpdate, getCollection } from "../shared/db";
import { config } from "../shared/config";
import { ApiError } from "../shared/errors";
import { generateId, isoNow, requireString, toDate } from "../shared/utils";
import type {
  BookingDoc,
  BusinessDoc,
  CancellationPolicy,
  CustomerDoc,
  PaymentDoc,
  ServiceDoc,
  StaffDoc,
  UserDoc,
  WaitlistDoc,
} from "../types/domain";
import { BookingStatus, PaymentType, PromotionType, ACTIVE_BOOKING_STATUSES } from "../types/enums";
import {
  assertSlotIsFree,
  depositFor,
  priceForStaff,
  resolveService,
} from "./availability.service";
import { assertTransition, releasesSlot } from "./booking-state.service";
import { findActiveLastMinutePromotion, applyDiscount } from "./promotion.service";
import { publishInstantSlotForCancellation } from "./instant-slot.service";
import { sendNotification } from "./notification.service";

export function buildSlotKey(staffId: string, startAt: string): string {
  return `${staffId}::${new Date(startAt).toISOString()}`;
}

async function nextBookingRef(): Promise<string> {
  const latest = await getCollection<BookingDoc>(Collections.bookings)
    .find({}, { projection: { bookingRef: 1 } })
    .sort({ bookingRef: -1 })
    .limit(1)
    .toArray();
  const last = latest[0]?.bookingRef ?? "LYN-100000";
  const numeric = Number(last.replace(/\D/g, ""));
  const next = Number.isFinite(numeric) ? numeric + 1 : 100231;
  return `LYN-${next}`;
}

export interface CreateBookingInput {
  customerUserId: string;
  businessId: string;
  serviceId: string;
  staffId: string;
  locationId: string;
  startAt: string;
  notes?: string;
  addOnNames?: string[];
  promotionId?: string;
  instantSlotId?: string;
  source?: string;
  isWalkIn?: boolean;
}

export interface CreateBookingResult {
  booking: BookingDoc;
  policy: CancellationPolicy;
}

/**
 * Stamps the business's *current* cancellation policy onto the booking. It is never
 * re-read later, so a later policy change cannot retroactively alter what this
 * customer agreed to.
 */
export function snapshotPolicy(policy: CancellationPolicy): CancellationPolicy {
  return {
    freeCancelHours: policy.freeCancelHours,
    rescheduleWindowHours: policy.rescheduleWindowHours,
    lateCancelDepositForfeitPercent: policy.lateCancelDepositForfeitPercent,
    noShowDepositForfeitPercent: policy.noShowDepositForfeitPercent,
  };
}

export async function createBooking(
  input: CreateBookingInput,
  options: { policyAgreed: boolean },
): Promise<CreateBookingResult> {
  if (options.policyAgreed !== true) {
    throw ApiError.unprocessable("You must accept the cancellation policy to confirm", {
      requiredField: "policyAgreed",
    });
  }

  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: input.businessId,
  });
  if (!business) throw ApiError.notFound("Business not found");
  if (business.status === "suspended") {
    throw ApiError.unprocessable("This business is suspended and cannot take bookings");
  }

  const service: ServiceDoc = await resolveService(input.businessId, input.serviceId);

  // Re-validate the slot server-side; never trust a client-supplied time.
  const slot = await assertSlotIsFree(
    input.businessId,
    input.serviceId,
    input.startAt,
    input.staffId,
    input.locationId,
  );

  const staff = await getCollection<StaffDoc>(Collections.staff).findOne({
    _id: input.staffId,
    businessId: input.businessId,
  });
  if (!staff) throw ApiError.notFound("Staff member not found");

  const addOns = (service.addOns ?? []).filter((addOn) =>
    (input.addOnNames ?? []).includes(addOn.name),
  );
  const basePrice = priceForStaff(service, staff._id);
  const addOnPrice = addOns.reduce((sum, addOn) => sum + addOn.priceMinor, 0);
  const addOnDuration = addOns.reduce((sum, addOn) => sum + addOn.durationMin, 0);
  const totalDuration = service.durationMin + addOnDuration;

  const promotion = input.promotionId
    ? await findActiveLastMinutePromotion(input.businessId, input.promotionId)
    : null;

  let discountMinor = 0;
  if (input.instantSlotId) {
    const instantSlot = await getCollection(Collections.instantSlots).findOne({
      _id: input.instantSlotId,
      businessId: input.businessId,
    });
    if (!instantSlot) throw ApiError.notFound("Instant slot not found");
    if (instantSlot.status !== "open") {
      throw ApiError.conflict("That instant slot has already been taken");
    }
    discountMinor = Math.max(0, basePrice - Number(instantSlot.discountedPriceMinor ?? basePrice));
  } else if (promotion) {
    discountMinor = applyDiscount(basePrice, promotion.discount);
  }

  const subtotalMinor = basePrice + addOnPrice;
  const deposit = depositFor(service, Math.max(0, subtotalMinor - discountMinor));
  const customer = await ensureCustomerRecord(input.businessId, input.customerUserId);

  const startAt = new Date(slot.startAt);
  const endAt = new Date(startAt.getTime() + totalDuration * 60_000);
  const at = isoNow();

  const booking: BookingDoc = {
    _id: generateId("bkg"),
    bookingRef: await nextBookingRef(),
    businessId: input.businessId,
    locationId: input.locationId,
    staffId: input.staffId,
    resourceId: null,
    customerUserId: input.customerUserId,
    customerId: customer._id,
    source: input.source ?? "marketplace",
    isWalkIn: input.isWalkIn === true,
    groupSize: 1,
    seriesId: null,
    recurrence: null,
    items: [
      {
        serviceId: service._id,
        name: addOns.length > 0 ? `${service.name} + ${addOns.length} add-on(s)` : service.name,
        durationMin: totalDuration,
        priceMinor: subtotalMinor,
        staffId: staff._id,
      },
    ],
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    status: BookingStatus.PENDING,
    pricing: {
      subtotalMinor,
      discountMinor,
      tipMinor: 0,
      totalMinor: Math.max(0, subtotalMinor - discountMinor),
    },
    deposit: {
      required: deposit.required,
      amountMinor: deposit.amountMinor,
      paymentId: null,
      status: deposit.required ? "due" : "none",
    },
    policySnapshot: snapshotPolicy(business.cancellationPolicy),
    policyAgreedAt: at,
    promotionId: promotion?._id ?? null,
    instantSlotId: input.instantSlotId ?? null,
    orderId: null,
    paymentIds: [],
    reviewId: null,
    cancellation: null,
    rescheduledFrom: null,
    notes: input.notes ?? null,
    statusHistory: [{ status: BookingStatus.PENDING, at, by: input.customerUserId }],
    slotKey: buildSlotKey(staff._id, startAt.toISOString()),
    slotActive: true,
    createdAt: at,
    updatedAt: at,
  };

  // The unique partial index on `slotKey` is the real double-booking guard. A
  // duplicate-key error here means a concurrent request won the slot.
  await getCollection<BookingDoc>(Collections.bookings).insertOne(booking);

  if (input.instantSlotId) {
    await getCollection(Collections.instantSlots).updateOne(
      { _id: input.instantSlotId, status: "open" },
      { $set: { status: "booked", bookedBookingId: booking._id, updatedAt: at } },
    );
  }

  await getCollection(Collections.waitlists).updateMany(
    { businessId: input.businessId, customerUserId: input.customerUserId, status: "active" },
    { $set: { status: "converted", bookingId: booking._id, updatedAt: at } },
  );

  await sendNotification({
    userId: input.customerUserId,
    type: "booking_requested",
    title: "Booking request received",
    body: `${service.name} with ${staff.displayName}. Complete payment to confirm.`,
    data: { bookingId: booking._id },
  });

  return { booking, policy: booking.policySnapshot };
}

/** The CRM `customers` row is the per-business view of a `User`. */
export async function ensureCustomerRecord(
  businessId: string,
  userId: string,
): Promise<CustomerDoc> {
  const existing = await getCollection<CustomerDoc>(Collections.customers).findOne({
    businessId,
    userId,
  });
  if (existing) return existing;

  const user = await getCollection<UserDoc>(Collections.users).findOne({ _id: userId });
  if (!user) throw ApiError.notFound("User not found");

  const at = isoNow();
  const doc: CustomerDoc = {
    _id: generateId("cus"),
    businessId,
    userId,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    email: user.email,
    phone: user.phone ?? null,
    dateOfBirth: user.dateOfBirth ?? null,
    stats: {
      totalAppointments: 0,
      lifetimeSpendMinor: 0,
      avgSpendMinor: 0,
      cancellations: 0,
      noShows: 0,
      lastVisitAt: null,
      upcomingBookingId: null,
    },
    insights: {
      avgRebookIntervalDays: null,
      nextExpectedVisit: null,
      overdueDays: 0,
      isOverdue: false,
      suggestedAction: null,
      segments: ["new"],
    },
    notes: [],
    allergies: [],
    tags: [],
    loyaltyPoints: 0,
    giftCardBalanceMinor: 0,
    membershipId: null,
    marketingConsent: user.marketingConsent ?? { sms: false, email: false, push: false },
    beforeAfterImages: [],
    source: "marketplace",
    isBlocked: false,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<CustomerDoc>(Collections.customers).insertOne(doc);
  return doc;
}

export interface DepositForfeitOutcome {
  isLate: boolean;
  feeRetainedMinor: number;
  refundedMinor: number;
  status: "none" | "refunded" | "partially_refunded" | "forfeited";
  by: "customer" | "business" | "admin";
}

/**
 * Deposit forfeit maths, driven entirely by `booking.policySnapshot` — the terms
 * captured at booking time, not the business's current policy.
 */
export function computeDepositOutcome(
  booking: BookingDoc,
  nextStatus: BookingStatus,
  by: "customer" | "business" | "admin",
  hoursUntilStart: number,
): DepositForfeitOutcome {
  const base = {
    feeRetainedMinor: 0,
    refundedMinor: 0,
    by,
  };

  if (booking.deposit.status !== "paid" || booking.deposit.amountMinor <= 0) {
    const isLate = by === "customer" && hoursUntilStart < booking.policySnapshot.freeCancelHours;
    return { ...base, isLate, status: "none" };
  }

  if (nextStatus === BookingStatus.LATE_CANCEL) {
    const percent = booking.policySnapshot.lateCancelDepositForfeitPercent;
    const feeRetainedMinor = Math.round((booking.deposit.amountMinor * percent) / 100);
    return {
      ...base,
      isLate: true,
      feeRetainedMinor,
      refundedMinor: booking.deposit.amountMinor - feeRetainedMinor,
      status: feeRetainedMinor > 0 ? "partially_refunded" : "refunded",
    };
  }

  if (nextStatus === BookingStatus.NO_SHOW) {
    const percent = booking.policySnapshot.noShowDepositForfeitPercent;
    const feeRetainedMinor = Math.round((booking.deposit.amountMinor * percent) / 100);
    return {
      ...base,
      isLate: true,
      feeRetainedMinor,
      refundedMinor: booking.deposit.amountMinor - feeRetainedMinor,
      status: feeRetainedMinor >= booking.deposit.amountMinor ? "forfeited" : "partially_refunded",
    };
  }

  // Business or admin cancellation: the customer is always made whole.
  return {
    ...base,
    isLate: false,
    feeRetainedMinor: 0,
    refundedMinor: booking.deposit.amountMinor,
    status: "refunded",
  };
}

export interface StatusChangeResult {
  booking: BookingDoc;
  outcome: DepositForfeitOutcome;
  instantSlotId: string | null;
}

export async function changeBookingStatus(
  bookingId: string,
  nextStatus: BookingStatus,
  actorId: string,
  reason: string | null,
  options: { via: "customer" | "business" | "admin" } ,
): Promise<StatusChangeResult> {
  const bookings = getCollection<BookingDoc>(Collections.bookings);
  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking) throw ApiError.notFound("Booking not found");

  assertTransition(booking.status, nextStatus);

  if (options.via === "customer") {
    if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      throw ApiError.unprocessable(`A "${booking.status}" booking can no longer be changed`);
    }
  }

  const hoursUntilStart =
    (new Date(booking.startAt).getTime() - Date.now()) / (60 * 60 * 1000);
  const outcome = computeDepositOutcome(booking, nextStatus, options.via, hoursUntilStart);
  const at = isoNow();

  const update: Partial<BookingDoc> = {
    status: nextStatus,
    updatedAt: at,
    statusHistory: [
      ...(booking.statusHistory ?? []),
      { status: nextStatus, at, by: actorId },
    ],
    ...(releasesSlot(nextStatus) ? { slotActive: false } : {}),
  };

  if (options.via === "customer") {
    update.cancellation = {
      by: "customer",
      at,
      reason,
      isLate: outcome.isLate,
      feeRetainedMinor: outcome.feeRetainedMinor,
      refundedMinor: outcome.refundedMinor,
    };
  }

  const updated = await bookings.findOneAndUpdate(
    { _id: bookingId, status: booking.status },
    { $set: update },
    { returnDocument: "after" },
  );
  if (!updated) throw ApiError.conflict("Booking changed while you were updating it");

  if (nextStatus === BookingStatus.ATTENDED) {
    await applyAttendedSideEffects(updated, actorId);
  }

  if (outcome.refundedMinor > 0) {
    await refundDeposit(updated, outcome.refundedMinor, outcome.status, at);
  }

  // Instant Slot auto-publish: a cancellation close to startAt becomes a
  // discounted open slot, using the business's active last-minute promotion.
  let instantSlotId: string | null = null;
  if (releasesSlot(nextStatus)) {
    const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
      _id: updated.businessId,
    });
    const autoEnabled = business?.settings?.autoInstantSlots !== false;
    if (autoEnabled && hoursUntilStart <= config.availability.instantSlotWindowHours) {
      instantSlotId = await publishInstantSlotForCancellation(updated, {
        auto: true,
        actorId,
      });
    }
  }

  if (nextStatus === BookingStatus.ATTENDED) {
    await sendNotification({
      userId: updated.customerUserId,
      type: "booking_attended",
      title: "How was your appointment?",
      body: "Leave a review to earn loyalty points.",
      data: { bookingId: updated._id },
    });
  }

  return { booking: updated, outcome, instantSlotId };
}

async function refundDeposit(
  booking: BookingDoc,
  amountMinor: number,
  status: string,
  at: string,
): Promise<void> {
  if (!booking.deposit.paymentId) return;
  const payments = getCollection<PaymentDoc>(Collections.payments);
  const payment = await payments.findOne({ _id: booking.deposit.paymentId });
  if (!payment) return;

  const refundId = `re_${generateId("rf").slice(-8)}`;
  await payments.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: status === "refunded" ? "refunded" : "partially_refunded",
        netMinor: Math.max(0, payment.netMinor - amountMinor),
        updatedAt: at,
      },
      $push: {
        refunds: {
          refundId,
          amountMinor,
          reason: "policy_forfeit_refund",
          status: "succeeded",
          createdAt: at,
        },
      },
    },
  );
  await getCollection<BookingDoc>(Collections.bookings).updateOne(
    { _id: booking._id },
    { $set: { "deposit.status": status, updatedAt: at } },
  );
}

async function applyAttendedSideEffects(booking: BookingDoc, actorId: string): Promise<void> {
  const at = isoNow();
  const customers = getCollection<CustomerDoc>(Collections.customers);
  const customer = await customers.findOne({ _id: booking.customerId });
  if (customer) {
    const totalAppointments = customer.stats.totalAppointments + 1;
    const lifetimeSpendMinor = customer.stats.lifetimeSpendMinor + booking.pricing.totalMinor;
    await customers.updateOne(
      { _id: customer._id },
      {
        $set: {
          "stats.totalAppointments": totalAppointments,
          "stats.lifetimeSpendMinor": lifetimeSpendMinor,
          "stats.avgSpendMinor": Math.round(lifetimeSpendMinor / totalAppointments),
          "stats.lastVisitAt": booking.startAt,
          "stats.upcomingBookingId": null,
          updatedAt: at,
        },
      },
    );
  }

  await getCollection<StaffDoc>(Collections.staff).updateOne(
    { _id: booking.staffId },
    asUpdate<StaffDoc>({
      $inc: {
        "performance.appointments": 1,
        "performance.revenueMinor": booking.pricing.totalMinor,
      },
      $set: { updatedAt: at },
    }),
  );

  const staff = await getCollection<StaffDoc>(Collections.staff).findOne({ _id: booking.staffId });
  if (staff?.commission && staff.commission.type !== "none" && staff.commission.value > 0) {
    const commissionMinor =
      staff.commission.type === "percentage"
        ? Math.round((booking.pricing.totalMinor * staff.commission.value) / 100)
        : Math.min(staff.commission.value, booking.pricing.totalMinor);
    await getCollection<BookingDoc>(Collections.bookings).updateOne(
      { _id: booking._id },
      { $set: { "pricing.commissionMinor": commissionMinor, updatedAt: at } },
    );
  }
  void actorId;
}

export interface RescheduleResult {
  booking: BookingDoc;
  previous: { startAt: string; endAt: string };
}

export async function rescheduleBooking(
  bookingId: string,
  newStartAtIso: string,
  actorId: string,
): Promise<RescheduleResult> {
  const bookings = getCollection<BookingDoc>(Collections.bookings);
  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
    throw ApiError.unprocessable(`A "${booking.status}" booking cannot be rescheduled`);
  }

  const item = booking.items[0];
  if (!item) throw ApiError.unprocessable("Booking has no line items to reschedule");

  const hoursUntilStart = (new Date(booking.startAt).getTime() - Date.now()) / 3_600_000;
  if (hoursUntilStart < booking.policySnapshot.rescheduleWindowHours) {
    throw ApiError.unprocessable(
      `Rescheduling closes ${booking.policySnapshot.rescheduleWindowHours}h before the appointment`,
      { hoursUntilStart: Math.round(hoursUntilStart) },
    );
  }

  // Claim the new slot first; if it is taken we have not touched the old one.
  const slot = await assertSlotIsFree(
    booking.businessId,
    item.serviceId,
    newStartAtIso,
    booking.staffId,
    booking.locationId,
  );

  const newStart = new Date(slot.startAt);
  const newEnd = new Date(newStart.getTime() + item.durationMin * 60_000);
  const at = isoNow();

  // Release the old slot, then claim the new one. The unique index on `slotKey`
  // still guards the claim.
  const result = await bookings.findOneAndUpdate(
    { _id: bookingId, slotKey: booking.slotKey ?? null },
    {
      $set: {
        startAt: newStart.toISOString(),
        endAt: newEnd.toISOString(),
        slotKey: buildSlotKey(booking.staffId, newStart.toISOString()),
        slotActive: true,
        rescheduledFrom: { startAt: booking.startAt, endAt: booking.endAt, at },
        updatedAt: at,
        statusHistory: [
          ...(booking.statusHistory ?? []),
          { status: booking.status, at, by: actorId },
        ],
      },
    },
    { returnDocument: "after" },
  );

  if (!result) {
    throw ApiError.conflict("Booking changed while you were rescheduling it");
  }

  return {
    booking: result,
    previous: { startAt: booking.startAt, endAt: booking.endAt },
  };
}

export interface WaitlistInput {
  customerUserId: string;
  businessId: string;
  serviceId: string;
  locationId?: string;
  staffId?: string | null;
  preferredDates: string[];
  preferredTimeRanges: Array<[string, string]>;
  notifyVia: string[];
  expiresAt: string;
}

export async function joinWaitlist(input: WaitlistInput): Promise<WaitlistDoc> {
  const at = isoNow();
  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: input.businessId,
  });
  if (!business) throw ApiError.notFound("Business not found");
  await ensureCustomerRecord(input.businessId, input.customerUserId);

  const doc: WaitlistDoc = {
    _id: generateId("wlt"),
    businessId: input.businessId,
    locationId: input.locationId ?? null,
    customerUserId: input.customerUserId,
    serviceId: input.serviceId,
    staffId: input.staffId ?? null,
    preferredDates: input.preferredDates,
    preferredTimeRanges: input.preferredTimeRanges,
    notifyVia: input.notifyVia,
    status: "active",
    notifiedAt: null,
    instantSlotId: null,
    bookingId: null,
    expiresAt: input.expiresAt,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<WaitlistDoc>(Collections.waitlists).insertOne(doc);
  return doc;
}

export async function notifyWaitlist(
  waitlistId: string,
  businessId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  const at = isoNow();
  const waitlists = getCollection(Collections.waitlists);
  const entry = await waitlists.findOne({ _id: waitlistId, businessId });
  if (!entry) throw ApiError.notFound("Waitlist entry not found");
  if (entry.status !== "active") {
    throw ApiError.unprocessable(`Waitlist entry is already "${entry.status}"`);
  }

  const instantSlotId =
    typeof entry.instantSlotId === "string" ? entry.instantSlotId : null;
  const service = await resolveService(
    businessId,
    requireString(entry.serviceId, "serviceId"),
  );

  await waitlists.updateOne(
    { _id: waitlistId },
    { $set: { status: "notified", notifiedAt: at, updatedAt: at } },
  );

  await sendNotification({
    userId: requireString(entry.customerUserId, "customerUserId"),
    type: "waitlist_slot_available",
    title: "A slot just opened!",
    body: `${service.name} is available. Tap to claim it before it goes.`,
    data: { waitlistId, ...(instantSlotId ? { instantSlotId } : {}) },
  });
  void actorId;

  return { waitlistId, status: "notified", notifiedAt: at };
}

export { PaymentType, PromotionType, toDate };
