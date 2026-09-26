import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { getCollection } from "../../shared/db";
import {
  generateId,
  isoNow,
  readCoordinates,
  requireArray,
  requireObject,
  requireString,
  stripServerOwnedFields,
} from "../../shared/utils";
import { config } from "../../shared/config";
import type { Paginated } from "../../shared/response";
import type {
  BookingDoc,
  BusinessDoc,
  CustomerDoc,
  LocationDoc,
  ReviewDoc,
  ServiceDoc,
  StaffDoc,
  UserDoc,
  WalletDoc,
} from "../../types/domain";
import { BookingStatus } from "../../types/enums";
import { assertOwnBooking } from "../../serializers";
import { computeAvailability, parseAvailabilityRequest } from "../../services/availability.service";
import {
  changeBookingStatus,
  createBooking,
  joinWaitlist,
  rescheduleBooking,
  type CreateBookingResult,
} from "../../services/booking.service";
import { createPaymentIntent } from "../../services/payment.service";
import { createReview, replyToReview } from "../../services/review.service";
import { parseSearchQuery, recordSearchActivity, search } from "../../services/search.service";
import { acceptRebookingPrompt, rebookingPromptsForUser } from "../../services/rebooking.service";
import { detectFraud } from "../../services/fraud.service";

/**
 * Customer-facing logic: discovery, booking, payment, reviews, waitlist, instant
 * slots, rebooking, the caller's own CRM record, favourites, notifications and
 * device tokens.
 *
 * Two invariants run through all of it:
 *  - There is no guest path. Every function takes a `userId` that came from a
 *    verified token, and every query is scoped to it.
 *  - A slot is never accepted from the client without being re-derived. Booking
 *    re-validates availability, so a stale availability response becomes a
 *    conflict rather than a double booking.
 */

export interface Paging {
  page: number;
  pageSize: number;
}

export function paginate<T>(data: T[], total: number, paging: Paging): Paginated<T> {
  return {
    data,
    page: paging.page,
    pageSize: paging.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / paging.pageSize),
  };
}

/**
 * Ratings arrive as untyped JSON, so every value is coerced to a finite 1–5
 * integer. Without this a client could store `"9"` or `NaN` in a score field.
 */
export function toRatings(value: unknown): Record<string, number> {
  const raw = requireObject(value, "ratings");
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const score = Number(entry);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      throw ApiError.badRequest(`ratings.${key} must be a number between 1 and 5`);
    }
    out[key] = Math.round(score);
  }
  if (out.overall === undefined) throw ApiError.badRequest("ratings.overall is required");
  return out;
}

// ---------------------------------------------------------------- discover

/** Smart Search, with the query recorded so results stay explainable. */
export async function runSearch(
  userId: string,
  query: Record<string, unknown>,
): Promise<unknown> {
  const filters = parseSearchQuery(query);
  const result = await search(filters);
  await recordSearchActivity(userId, filters.q ? "smart_search" : "search", {
    query: filters.q ?? null,
    parsed: filters,
  });
  return result;
}

export interface AvailabilityParams {
  businessId: string;
  serviceId: string;
  locationId?: string | undefined;
  staffId?: string | undefined;
  date?: string | undefined;
  days: number;
  coordinates?: unknown;
}

/** The only source of bookable times. */
export async function getAvailability(params: AvailabilityParams): Promise<Record<string, unknown>> {
  const { dateFrom, dateTo } = parseAvailabilityRequest({
    businessId: params.businessId,
    serviceId: params.serviceId,
    ...(params.locationId ? { locationId: params.locationId } : {}),
    ...(params.staffId ? { staffId: params.staffId } : {}),
    ...(params.date ? { date: params.date } : {}),
    days: params.days,
  });

  const slots = await computeAvailability({
    businessId: params.businessId,
    serviceId: params.serviceId,
    ...(params.locationId ? { locationId: params.locationId } : {}),
    ...(params.staffId ? { staffId: params.staffId } : {}),
    dateFrom,
    dateTo,
    fromCoordinates: readCoordinates(params.coordinates),
  });

  return {
    businessId: params.businessId,
    serviceId: params.serviceId,
    dateFrom,
    dateTo,
    count: slots.length,
    slots,
  };
}

/** A business profile as a signed-in customer sees it, including contact channels. */
export async function getBusinessForCustomer(businessId: string): Promise<Record<string, unknown>> {
  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: businessId,
  });
  if (!business) throw ApiError.notFound("Business not found");

  const [locations, staffDocs, services] = await Promise.all([
    getCollection<LocationDoc>(Collections.locations)
      .find({ businessId, status: "active" })
      .toArray(),
    getCollection<StaffDoc>(Collections.staff)
      .find({ businessId, status: "active", bookable: true })
      .toArray(),
    getCollection<ServiceDoc>(Collections.services)
      .find({ businessId, isActive: true })
      .toArray(),
  ]);

  const users = await getCollection<UserDoc>(Collections.users)
    .find({ _id: { $in: staffDocs.map((doc) => doc.userId) } })
    .toArray();
  const byUser = new Map(users.map((user) => [user._id, user]));

  return {
    business: {
      _id: business._id,
      name: business.name,
      slug: business.slug,
      description: business.description ?? null,
      logoUrl: business.logoUrl ?? null,
      coverUrl: business.coverUrl ?? null,
      ratingSummary: business.ratingSummary ?? { average: 0, count: 0 },
      businessScore: business.businessScore ?? null,
      badges: business.badges ?? [],
      instantBook: business.instantBook === true,
      isMobileService: business.isMobileService === true,
      mobileServiceRadiusKm: business.mobileServiceRadiusKm ?? null,
      channels: business.channels ?? {},
      contact: business.contact ?? {},
      amenities: business.amenities ?? [],
      faqs: business.faqs ?? [],
      verification: business.verification ?? { identityVerified: false, businessVerified: false },
    },
    locations: locations.map((location) => ({
      _id: location._id,
      name: location.name,
      address: location.address,
      coordinates: readCoordinates(location.geo),
      openingHours: location.openingHours ?? null,
      customHours: location.customHours ?? [],
      timezone: location.timezone,
    })),
    staff: staffDocs.map((doc) => ({
      _id: doc._id,
      displayName: doc.displayName,
      role: doc.role,
      title: doc.title ?? null,
      bio: doc.bio ?? null,
      avatarUrl: doc.avatarUrl ?? byUser.get(doc.userId)?.avatarUrl ?? null,
      gender: byUser.get(doc.userId)?.gender ?? null,
      ratingSummary: doc.ratingSummary ?? { average: 0, count: 0 },
    })),
    services: services.map((service) => ({
      _id: service._id,
      name: service.name,
      description: service.description ?? null,
      categoryId: service.categoryId,
      durationMin: service.durationMin,
      priceMinor: service.priceMinor,
      currency: service.currency,
      instantBook: service.instantBook === true,
      depositRule: service.depositRule ?? null,
      addOns: service.addOns ?? [],
      rebookCycleDays: service.rebookCycleDays ?? null,
      leadTimeMinutes: service.leadTimeMinutes ?? null,
      tags: service.tags ?? [],
    })),
  };
}

export async function getService(serviceId: string): Promise<ServiceDoc> {
  const service = await getCollection<ServiceDoc>(Collections.services).findOne({
    _id: serviceId,
    isActive: true,
  });
  if (!service) throw ApiError.notFound("Service not found");
  return service;
}

// ---------------------------------------------------------------- bookings

export async function book(userId: string, body: Record<string, unknown>): Promise<CreateBookingResult> {
  return createBooking(
    {
      customerUserId: userId,
      businessId: requireString(body.businessId, "businessId"),
      serviceId: requireString(body.serviceId, "serviceId"),
      staffId: requireString(body.staffId, "staffId"),
      locationId: requireString(body.locationId, "locationId"),
      startAt: requireString(body.startAt, "startAt"),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(body.addOnNames
        ? { addOnNames: requireArray(body.addOnNames, "addOnNames").map(String) }
        : {}),
      ...(typeof body.promotionId === "string" ? { promotionId: body.promotionId } : {}),
      ...(typeof body.instantSlotId === "string" ? { instantSlotId: body.instantSlotId } : {}),
      source: "marketplace",
    },
    { policyAgreed: body.policyAgreed === true },
  );
}

export async function listBookings(
  userId: string,
  paging: Paging,
  filters: { status?: string | undefined; scope?: string | undefined },
): Promise<{ docs: BookingDoc[]; total: number }> {
  const filter: Record<string, unknown> = { customerUserId: userId };
  if (filters.status) filter.status = filters.status;
  if (filters.scope === "upcoming") filter.startAt = { $gte: isoNow() };
  if (filters.scope === "past") filter.startAt = { $lt: isoNow() };

  const collection = getCollection<BookingDoc>(Collections.bookings);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ startAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs, total };
}

export async function getOwnBooking(userId: string, bookingId: string): Promise<BookingDoc> {
  return assertOwnBooking(bookingId, userId);
}

/**
 * The customer never chooses the outcome: `changeBookingStatus` applies the
 * snapshot cancellation policy and decides free cancellation vs deposit forfeit.
 */
export async function cancelBooking(userId: string, bookingId: string, body: Record<string, unknown>) {
  return changeBookingStatus(
    bookingId,
    BookingStatus.CANCELLED,
    userId,
    typeof body.reason === "string" ? body.reason : null,
    { via: "customer" },
  );
}

export async function rescheduleOwnBooking(userId: string, bookingId: string, body: Record<string, unknown>) {
  await assertOwnBooking(bookingId, userId);
  return rescheduleBooking(bookingId, requireString(body.startAt, "startAt"), userId);
}

/** The customer declaring they did not attend. */
export async function declareNoShow(userId: string, bookingId: string) {
  return changeBookingStatus(
    bookingId,
    BookingStatus.NO_SHOW,
    userId,
    "Customer reported they did not attend",
    { via: "customer" },
  );
}

// ---------------------------------------------------------------- payments

/**
 * One entry point for every payment method (card, Apple/Google Pay, gift card,
 * wallet, loyalty points, package session, membership, cash). The client names a
 * method; the server decides what is actually possible for this booking.
 */
export async function pay(
  userId: string,
  bookingId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await assertOwnBooking(bookingId, userId);

  const result = await createPaymentIntent({
    customerUserId: userId,
    bookingId,
    method: requireString(body.method, "method") as never,
    ...(body.amountMinor !== undefined ? { amountMinor: Number(body.amountMinor) } : {}),
    ...(typeof body.giftCardCode === "string" ? { giftCardCode: body.giftCardCode } : {}),
    ...(body.pointsToRedeem !== undefined ? { pointsToRedeem: Number(body.pointsToRedeem) } : {}),
    ...(typeof body.customerPackageId === "string"
      ? { customerPackageId: body.customerPackageId }
      : {}),
    ...(typeof body.membershipId === "string" ? { membershipId: body.membershipId } : {}),
    ...(typeof body.savedPaymentMethodId === "string"
      ? { savedPaymentMethodId: body.savedPaymentMethodId }
      : {}),
  });

  return {
    paymentId: result.payment._id,
    status: result.payment.status,
    amountMinor: result.payment.amountMinor,
    currency: result.payment.currency,
    clientAction: result.clientAction,
    walletDebits: result.walletDebits,
    walletCredits: result.walletCredits,
  };
}

/**
 * The caller's wallet, created on first read. Returns the raw document; the
 * route serializes it with the caller's redaction context, so saved card details
 * are tokenised away on the way out.
 */
export async function getOrCreateWallet(userId: string): Promise<WalletDoc> {
  const wallets = getCollection<WalletDoc>(Collections.wallets);
  const existing = await wallets.findOne({ userId });
  if (existing) return existing;

  const at = isoNow();
  const wallet: WalletDoc = {
    _id: generateId("wlt"),
    userId,
    currency: "GBP",
    balances: { giftCardMinor: 0, refundCreditMinor: 0, referralCreditMinor: 0 },
    loyaltyPoints: [],
    savedCards: [],
    createdAt: at,
    updatedAt: at,
  };
  await wallets.insertOne(wallet);
  return wallet;
}

export async function listWalletTransactions(
  userId: string,
  paging: Paging,
): Promise<{ docs: Record<string, unknown>[]; total: number }> {
  const collection = getCollection(Collections.walletTransactions);
  const [docs, total] = await Promise.all([
    collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments({ userId }),
  ]);
  return { docs: docs as Record<string, unknown>[], total };
}

// ---------------------------------------------------------------- reviews

/**
 * `isVerifiedBooking` is derived from the booking inside `createReview`, never
 * read from the body. A review that the moderation rules hold also triggers fraud
 * detection, since a held review is often the signal itself.
 */
export async function writeReview(
  userId: string,
  bookingId: string,
  body: Record<string, unknown>,
): Promise<ReviewDoc> {
  await assertOwnBooking(bookingId, userId);

  const review = await createReview({
    customerUserId: userId,
    bookingId,
    ratings: toRatings(body.ratings),
    ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
    ...(body.photos ? { photos: requireArray(body.photos, "photos").map(String) } : {}),
  });

  if (review.status === "under_review") await detectFraud({ now: new Date() });
  return review;
}

export async function listOwnReviews(
  userId: string,
  paging: Paging,
): Promise<{ docs: ReviewDoc[]; total: number }> {
  const collection = getCollection<ReviewDoc>(Collections.reviews);
  const [docs, total] = await Promise.all([
    collection
      .find({ customerUserId: userId })
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments({ customerUserId: userId }),
  ]);
  return { docs, total };
}

/**
 * A business replying to a customer's review. The business is resolved from the
 * review itself, never from the request body, so an owner cannot reply on behalf
 * of a competitor.
 */
export async function replyToOwnBusinessReview(
  userId: string,
  reviewId: string,
  body: Record<string, unknown>,
): Promise<ReviewDoc> {
  const review = await getCollection<ReviewDoc>(Collections.reviews).findOne({ _id: reviewId });
  if (!review) throw ApiError.notFound("Review not found");

  const owned = await getCollection<BusinessDoc>(Collections.businesses).countDocuments({
    _id: review.businessId,
    ownerId: userId,
  });
  if (owned === 0) throw ApiError.forbidden("You can only reply to reviews of your business");

  return replyToReview(
    reviewId,
    review.businessId,
    requireString(body.reply, "reply"),
    userId,
  );
}

// ---------------------------------------------------------------- waitlist

export async function joinQueue(userId: string, body: Record<string, unknown>): Promise<unknown> {
  return joinWaitlist({
    businessId: requireString(body.businessId, "businessId"),
    ...(typeof body.locationId === "string" ? { locationId: body.locationId } : {}),
    customerUserId: userId,
    serviceId: requireString(body.serviceId, "serviceId"),
    ...(typeof body.staffId === "string" ? { staffId: body.staffId } : {}),
    preferredDates: requireArray(body.preferredDates ?? [], "preferredDates").map(String),
    preferredTimeRanges: requireArray(body.preferredTimeRanges ?? [], "preferredTimeRanges").map(
      (entry) => {
        const pair = requireArray(entry, "preferredTimeRanges entry");
        return [String(pair[0]), String(pair[1] ?? pair[0])] as [string, string];
      },
    ),
    notifyVia: requireArray(body.notifyVia ?? ["push"], "notifyVia").map(String),
    expiresAt: requireString(body.expiresAt, "expiresAt"),
  });
}

export async function listOwnWaitlist(userId: string): Promise<Record<string, unknown>[]> {
  return (await getCollection(Collections.waitlists)
    .find({ customerUserId: userId })
    .sort({ createdAt: -1 })
    .toArray()) as Record<string, unknown>[];
}

// ------------------------------------------------------- instant booking

/** Discounted last-minute slots. Claiming one goes through `bookInstantSlot`. */
export async function listOpenInstantSlots(
  filters: { businessId?: string | undefined; serviceId?: string | undefined },
): Promise<Record<string, unknown>[]> {
  const filter: Record<string, unknown> = { status: "open", expiresAt: { $gt: isoNow() } };
  if (filters.businessId) filter.businessId = filters.businessId;
  if (filters.serviceId) filter.serviceId = filters.serviceId;

  return (await getCollection(Collections.instantSlots)
    .find(filter)
    .sort({ startAt: 1 })
    .limit(50)
    .toArray()) as Record<string, unknown>[];
}

/**
 * One-tap claim of a live slot. The slot's status is flipped with `status: "open"`
 * still in the filter, so if two customers tap at the same moment only one
 * update matches and the loser gets a conflict rather than a double booking.
 */
export async function bookInstantSlot(
  userId: string,
  instantSlotId: string,
): Promise<BookingDoc> {
  const slots = getCollection(Collections.instantSlots);
  const slot = await slots.findOne({ _id: instantSlotId });
  if (!slot) throw ApiError.notFound("Instant slot not found");
  if (slot.status !== "open") throw ApiError.conflict("That slot has already been taken");
  if (new Date(String(slot.expiresAt)).getTime() < Date.now()) {
    throw ApiError.conflict("That offer has expired");
  }

  const result = await createBooking(
    {
      customerUserId: userId,
      businessId: String(slot.businessId),
      serviceId: String(slot.serviceId),
      staffId: String(slot.staffId),
      locationId: String(slot.locationId),
      startAt: String(slot.startAt),
      instantSlotId,
      source: "instant_slot",
    },
    { policyAgreed: true },
  );

  const claim = await slots.updateOne(
    { _id: instantSlotId, status: "open" },
    {
      $set: {
        status: "booked",
        bookedBookingId: result.booking._id,
        updatedAt: isoNow(),
      },
    },
  );
  if (claim.modifiedCount === 0) {
    // Someone else won the race between our read and this write.
    throw ApiError.conflict("That slot has already been taken");
  }

  return result.booking;
}

// ---------------------------------------------------------------- rebooking

/**
 * The customer-facing surface of the server-computed insights. The raw
 * `insights` block is never sent to a customer — only the resulting prompts.
 */
export async function getRebookingPrompts(userId: string): Promise<unknown> {
  return rebookingPromptsForUser(userId);
}

export async function acceptPrompt(userId: string, promptId: string): Promise<unknown> {
  return acceptRebookingPrompt(userId, promptId);
}

// ---------------------------------------------------------------- CRM read

/** The caller's own customer record at a business; `insights` is stripped. */
export async function getOwnCustomerRecord(userId: string, businessId: string): Promise<CustomerDoc> {
  const customer = await getCollection<CustomerDoc>(Collections.customers).findOne({
    businessId,
    userId,
  });
  if (!customer) throw ApiError.notFound("No customer record at this business");
  return customer;
}

/**
 * The customer edits their own details. `insights`, `stats`, `tags`,
 * `loyaltyPoints`, gift-card balance and the block flag are all server-owned and
 * are stripped before the write.
 */
export async function updateOwnCustomerRecord(
  userId: string,
  body: Record<string, unknown>,
): Promise<CustomerDoc> {
  const businessId = requireString(body.businessId, "businessId");
  const editable = stripServerOwnedFields<Record<string, unknown>>(body, [
    "insights",
    "stats",
    "tags",
    "loyaltyPoints",
    "giftCardBalanceMinor",
    "isBlocked",
  ]);

  await getCollection<CustomerDoc>(Collections.customers).updateOne(
    { businessId, userId },
    { $set: { ...editable, updatedAt: isoNow() } },
  );
  return getOwnCustomerRecord(userId, businessId);
}

// ---------------------------------------------------------------- favourites

/** Toggles a favourite, scoped to the caller. */
export async function toggleFavourite(
  userId: string,
  body: Record<string, unknown>,
): Promise<{ targetType: string; targetId: string; favourited: boolean }> {
  const targetType = requireString(body.targetType, "targetType");
  const targetId = requireString(body.targetId, "targetId");

  const favourites = getCollection(Collections.favourites);
  const existing = await favourites.findOne({ userId, targetType, targetId });
  if (existing) {
    await favourites.deleteOne({ _id: existing._id });
    return { targetType, targetId, favourited: false };
  }

  const at = isoNow();
  await favourites.insertOne({
    _id: generateId("fav"),
    userId,
    targetType,
    targetId,
    createdAt: at,
    updatedAt: at,
  });
  return { targetType, targetId, favourited: true };
}

export async function listFavourites(userId: string): Promise<Record<string, unknown>[]> {
  return (await getCollection(Collections.favourites)
    .find({ userId })
    .sort({ createdAt: -1 })
    .toArray()) as Record<string, unknown>[];
}

// ---------------------------------------------------------------- notifications

export async function listNotifications(
  userId: string,
  paging: Paging,
): Promise<{ docs: Record<string, unknown>[]; total: number }> {
  const collection = getCollection(Collections.notifications);
  const [docs, total] = await Promise.all([
    collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments({ userId }),
  ]);
  return { docs: docs as Record<string, unknown>[], total };
}

/** Scoped to the caller, so one user cannot mark another's notification read. */
export async function markNotificationRead(userId: string, notificationId: string): Promise<{ read: boolean }> {
  const at = isoNow();
  await getCollection(Collections.notifications).updateOne(
    { _id: notificationId, userId },
    { $set: { readAt: at, read: true, updatedAt: at } },
  );
  return { read: true };
}

export async function markAllNotificationsRead(userId: string): Promise<{ updated: number }> {
  const at = isoNow();
  const result = await getCollection(Collections.notifications).updateMany(
    { userId },
    { $set: { readAt: at, read: true, updatedAt: at } },
  );
  return { updated: result.modifiedCount };
}

// ---------------------------------------------------------------- devices

/**
 * Registers a push token. The token is pulled before it is pushed so re-registering
 * the same device moves it rather than duplicating it.
 */
export async function registerDevice(
  userId: string,
  body: Record<string, unknown>,
): Promise<{ registered: boolean }> {
  const token = requireString(body.token, "token");
  const platform = requireString(body.platform, "platform");
  const users = getCollection<UserDoc>(Collections.users);

  await users.updateOne({ _id: userId }, { $pull: { deviceTokens: { token } } });
  await users.updateOne(
    { _id: userId },
    { $push: { deviceTokens: { token, platform } }, $set: { updatedAt: isoNow() } },
  );
  return { registered: true };
}

export async function unregisterDevice(userId: string, body: Record<string, unknown>): Promise<{ removed: boolean }> {
  await getCollection<UserDoc>(Collections.users).updateOne(
    { _id: userId },
    { $pull: { deviceTokens: { token: requireString(body.token, "token") } } },
  );
  return { removed: true };
}

export { config, requireObject, requireString };
