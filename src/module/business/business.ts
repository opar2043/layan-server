import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { getCollection } from "../../shared/db";
import {
  generateId,
  isoNow,
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
  DisputeDoc,
  InstantSlotDoc,
  LocationDoc,
  PaymentDoc,
  PromotionDoc,
  ReviewDoc,
  ServiceDoc,
  StaffDoc,
  TimeOffDoc,
} from "../../types/domain";
import { BookingStatus, StaffRole, UserRole } from "../../types/enums";
import { normalisePermissions } from "../../auth/middleware";
import { changeBookingStatus, notifyWaitlist, rescheduleBooking } from "../../services/booking.service";
import { computeAvailability } from "../../services/availability.service";
import { publishInstantSlotForCancellation } from "../../services/instant-slot.service";
import { parseRefundBody, refundPayment } from "../../services/payment.service";
import { createPromotion, findBusinessLastMinutePromotion } from "../../services/promotion.service";
import { computeBusinessScore, persistBusinessScore } from "../../services/score.service";
import { recomputeCustomerInsights } from "../../services/rebooking.service";
import { recomputeBadges } from "../../services/fraud.service";
import { sendNotification } from "../../services/notification.service";

/**
 * Owner, manager and stylist business logic.
 *
 * The access gate resolved by `requireBusinessAccess` is threaded into every
 * function as `gate` rather than read from the request, so this module never
 * touches `req` and its rules can be reused from a script or a test. Two things
 * the gate drives:
 *
 *  - `selfOnly` (a stylist) narrows every list query in the database itself, not
 *    in the serializer, so a stylist cannot page through a colleague's appointments.
 *  - `via === "staff"` with a non-owner role may edit hours but never permission
 *    flags, so a manager cannot grant themselves `viewFinancials`.
 *
 * Ownership is also asserted *before* every mutation, never after.
 */

export interface Paging {
  page: number;
  pageSize: number;
}

export interface AccessGate {
  selfOnly: boolean;
  staffId: string | null;
  staffRole: StaffRole | null;
  via: "owner" | "staff" | "admin";
}

export interface RangeFilters {
  from?: string | undefined;
  to?: string | undefined;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rangeFilter(field: string, filters: RangeFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (filters.from) filter[field] = { $gte: filters.from };
  if (filters.to) filter[field] = { ...(filter[field] as object), $lte: filters.to };
  return filter;
}

// ------------------------------------------------------------------ profile

/** Every business the caller owns, works for, or — as an admin — may administer. */
export async function listAccessibleBusinesses(
  userId: string,
  role: UserRole,
): Promise<BusinessDoc[]> {
  if (role === UserRole.ADMIN) {
    return getCollection<BusinessDoc>(Collections.businesses).find({}).limit(200).toArray();
  }

  const owned = await getCollection<BusinessDoc>(Collections.businesses)
    .find({ ownerId: userId })
    .toArray();
  if (owned.length > 0) return owned;

  const staffRows = await getCollection<StaffDoc>(Collections.staff)
    .find({ userId, status: "active" })
    .toArray();
  return getCollection<BusinessDoc>(Collections.businesses)
    .find({ _id: { $in: staffRows.map((row) => row.businessId) } })
    .toArray();
}

export async function getBusiness(businessId: string): Promise<BusinessDoc> {
  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: businessId,
  });
  if (!business) throw ApiError.notFound("Business not found");
  return business;
}

/**
 * Owner-only profile edits. `verification`, `badges`, `businessScore` and
 * `ratingSummary` are computed or admin-granted, and `ownerId`, `slug` and
 * `status` are administratively controlled — all stripped even if a client posts
 * them.
 */
const BUSINESS_SERVER_OWNED = [
  "verification",
  "badges",
  "businessScore",
  "ratingSummary",
  "ownerId",
  "slug",
  "status",
] as const;

export async function updateBusiness(
  businessId: string,
  body: Record<string, unknown>,
): Promise<BusinessDoc> {
  const editable = stripServerOwnedFields<BusinessDoc>(body, [...BUSINESS_SERVER_OWNED]);
  await getCollection<BusinessDoc>(Collections.businesses).updateOne(
    { _id: businessId },
    { $set: { ...editable, updatedAt: isoNow() } },
  );
  return getBusiness(businessId);
}

export interface DashboardSummary {
  /** Raw for the module; the route serializes it into `todayBookings`. */
  today: BookingDoc[];
  todayCount: number;
  todayByStatus: Record<string, number>;
  upcomingCount: number;
  lifetimeRevenueMinor: number;
  customerCount: number;
  lastScore: unknown;
}

/** Owner/manager numbers for today. */
export async function getDashboard(businessId: string): Promise<DashboardSummary> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 3_600_000);

  const bookings = getCollection<BookingDoc>(Collections.bookings);
  const [today, upcoming, attended, customers, score] = await Promise.all([
    bookings
      .find({
        businessId,
        startAt: { $gte: todayStart.toISOString(), $lt: todayEnd.toISOString() },
      })
      .sort({ startAt: 1 })
      .toArray(),
    bookings.countDocuments({
      businessId,
      startAt: { $gte: isoNow() },
      status: BookingStatus.CONFIRMED,
    }),
    bookings.find({ businessId, status: BookingStatus.ATTENDED, startAt: { $lt: isoNow() } }).toArray(),
    getCollection<CustomerDoc>(Collections.customers).countDocuments({ businessId }),
    getCollection(Collections.businessScores).findOne({ businessId }, { sort: { computedAt: -1 } }),
  ]);

  const byStatus = new Map<string, number>();
  for (const booking of today) byStatus.set(booking.status, (byStatus.get(booking.status) ?? 0) + 1);

  return {
    today,
    todayCount: today.length,
    todayByStatus: Object.fromEntries(byStatus),
    upcomingCount: upcoming,
    lifetimeRevenueMinor: attended.reduce((sum, b) => sum + b.pricing.totalMinor, 0),
    customerCount: customers,
    lastScore: score ?? null,
  };
}

// ----------------------------------------------------------------- calendar

/**
 * A stylist always sees only their own appointments — the restriction lives in
 * the query, and an explicit `staffId` for someone else is rejected outright
 * rather than quietly ignored.
 */
export async function listCalendar(
  businessId: string,
  gate: AccessGate,
  paging: Paging,
  range: RangeFilters,
  requestedStaffId: string | null,
): Promise<{ docs: BookingDoc[]; total: number }> {
  if (gate.selfOnly) {
    if (requestedStaffId && requestedStaffId !== gate.staffId) {
      throw ApiError.forbidden("A stylist can only view their own calendar");
    }
  } else if (requestedStaffId) {
    const staff = await getCollection<StaffDoc>(Collections.staff).findOne({
      _id: requestedStaffId,
      businessId,
    });
    if (!staff) throw ApiError.notFound("Staff member not found at this business");
  }

  const filter: Record<string, unknown> = { businessId, ...rangeFilter("startAt", range) };
  if (gate.selfOnly) filter.staffId = gate.staffId;
  else if (requestedStaffId) filter.staffId = requestedStaffId;

  const collection = getCollection<BookingDoc>(Collections.bookings);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ startAt: 1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs, total };
}

/** The owner's view of bookable slots. */
export async function getAvailability(
  businessId: string,
  serviceId: string,
  dateFrom: Date,
  days: number,
  filters: { staffId?: string | undefined; locationId?: string | undefined },
): Promise<unknown> {
  return computeAvailability({
    businessId,
    serviceId,
    dateFrom,
    dateTo: new Date(dateFrom.getTime() + days * 86_400_000),
    fromCoordinates: null,
    ...(filters.staffId ? { staffId: filters.staffId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
  });
}

export async function listTimeOff(
  businessId: string,
  gate: AccessGate,
  range: RangeFilters,
): Promise<TimeOffDoc[]> {
  const filter: Record<string, unknown> = { businessId, ...rangeFilter("startAt", range) };
  if (gate.selfOnly) filter.staffId = gate.staffId;
  return getCollection<TimeOffDoc>(Collections.timeOffs).find(filter).sort({ startAt: 1 }).toArray();
}

/** A stylist may block their own time; a manager may block anyone's. */
export async function createTimeOff(
  userId: string,
  businessId: string,
  gate: AccessGate,
  body: Record<string, unknown>,
): Promise<TimeOffDoc> {
  const requestedStaff = typeof body.staffId === "string" ? body.staffId : (gate.staffId ?? null);
  if (gate.selfOnly && requestedStaff !== gate.staffId) {
    throw ApiError.forbidden("A stylist can only block their own time");
  }

  const at = isoNow();
  const doc: TimeOffDoc = {
    _id: generateId("tof"),
    businessId,
    locationId: typeof body.locationId === "string" ? body.locationId : null,
    staffId: requestedStaff,
    type: requireString(body.type, "type"),
    title: typeof body.title === "string" ? body.title : null,
    startAt: requireString(body.startAt, "startAt"),
    endAt: requireString(body.endAt, "endAt"),
    allDay: body.allDay === true,
    recurrence: (body.recurrence as TimeOffDoc["recurrence"]) ?? null,
    createdBy: userId,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<TimeOffDoc>(Collections.timeOffs).insertOne(doc);
  return doc;
}

export async function deleteTimeOff(
  businessId: string,
  gate: AccessGate,
  id: string,
): Promise<{ deleted: true }> {
  const filter: Record<string, unknown> = { _id: id, businessId };
  if (gate.selfOnly) filter.staffId = gate.staffId;
  const result = await getCollection<TimeOffDoc>(Collections.timeOffs).deleteOne(filter);
  if (result.deletedCount === 0) throw ApiError.notFound("Time-off entry not found");
  return { deleted: true };
}

// ---------------------------------------------------------------- bookings

export async function listBusinessBookings(
  businessId: string,
  gate: AccessGate,
  paging: Paging,
  filters: { status?: string | undefined; staffId?: string | undefined },
): Promise<{ docs: BookingDoc[]; total: number }> {
  const filter: Record<string, unknown> = { businessId };
  if (filters.status) filter.status = filters.status;
  if (gate.selfOnly) filter.staffId = gate.staffId;
  else if (filters.staffId) filter.staffId = filters.staffId;

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

export async function getBusinessBooking(
  businessId: string,
  gate: AccessGate,
  id: string,
): Promise<BookingDoc> {
  const booking = await getCollection<BookingDoc>(Collections.bookings).findOne({
    _id: id,
    businessId,
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (gate.selfOnly && booking.staffId !== gate.staffId) {
    throw ApiError.forbidden("A stylist can only view their own appointments");
  }
  return booking;
}

/**
 * A stylist may only mark their own appointment attended/no-show. The transition
 * itself is validated by the shared state machine, never here.
 */
export async function changeBookingStatusAsBusiness(
  userId: string,
  businessId: string,
  gate: AccessGate,
  bookingId: string,
  body: Record<string, unknown>,
) {
  const existing = await getCollection<BookingDoc>(Collections.bookings).findOne({
    _id: bookingId,
    businessId,
  });
  if (!existing) throw ApiError.notFound("Booking not found");
  if (gate.selfOnly && existing.staffId !== gate.staffId) {
    throw ApiError.forbidden("A stylist can only update their own appointments");
  }

  const next = requireString(body.status, "status") as BookingStatus;
  if (!Object.values(BookingStatus).includes(next)) {
    throw ApiError.badRequest(`status must be one of ${Object.values(BookingStatus).join(", ")}`);
  }

  return changeBookingStatus(
    bookingId,
    next,
    userId,
    typeof body.reason === "string" ? body.reason : null,
    { via: gate.via === "admin" ? "admin" : "business" },
  );
}

/** A business-initiated move. Ownership is asserted before the mutation. */
export async function rescheduleAsBusiness(
  userId: string,
  businessId: string,
  bookingId: string,
  body: Record<string, unknown>,
) {
  const owned = await getCollection<BookingDoc>(Collections.bookings).findOne({
    _id: bookingId,
    businessId,
  });
  if (!owned) throw ApiError.notFound("Booking not found");

  return rescheduleBooking(bookingId, requireString(body.startAt, "startAt"), userId);
}

/** Publishes a cancellation as a discounted last-minute offer. */
export async function publishInstantSlot(
  userId: string,
  businessId: string,
  bookingId: string,
): Promise<{ instantSlotId: string; expiresInHours: number }> {
  const booking = await getCollection<BookingDoc>(Collections.bookings).findOne({
    _id: bookingId,
    businessId,
  });
  if (!booking) throw ApiError.notFound("Booking not found");

  const instantSlotId = await publishInstantSlotForCancellation(booking, {
    auto: false,
    actorId: userId,
  });
  if (!instantSlotId) {
    throw ApiError.unprocessable("This booking is too far away to publish as an instant slot");
  }
  return { instantSlotId, expiresInHours: config.availability.instantSlotWindowHours };
}

export async function listInstantSlots(businessId: string): Promise<InstantSlotDoc[]> {
  return getCollection<InstantSlotDoc>(Collections.instantSlots)
    .find({ businessId })
    .sort({ startAt: 1 })
    .limit(100)
    .toArray();
}

// ------------------------------------------------------------------ waitlist

export async function listWaitlist(businessId: string): Promise<Record<string, unknown>[]> {
  return (await getCollection(Collections.waitlists)
    .find({ businessId })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray()) as Record<string, unknown>[];
}

export async function notifyWaitlistEntry(
  userId: string,
  businessId: string,
  id: string,
): Promise<unknown> {
  return notifyWaitlist(id, businessId, userId);
}

// ------------------------------------------------------------------ customers

/**
 * The CRM list. `insights` is included on this side only, and only because the
 * route gates on `viewCustomerData`.
 */
export async function listCustomers(
  businessId: string,
  paging: Paging,
  q?: string | undefined,
): Promise<{ docs: CustomerDoc[]; total: number }> {
  const filter: Record<string, unknown> = { businessId };
  if (q) {
    const escaped = escapeRegex(q);
    filter.$or = [
      { firstName: { $regex: escaped, $options: "i" } },
      { lastName: { $regex: escaped, $options: "i" } },
      { email: { $regex: escaped, $options: "i" } },
      { phone: { $regex: escaped, $options: "i" } },
    ];
  }

  const collection = getCollection<CustomerDoc>(Collections.customers);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ updatedAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs, total };
}

/** One CRM record with that customer's recent bookings and reviews. */
export async function getCustomerDetail(
  businessId: string,
  id: string,
): Promise<{ customer: CustomerDoc; bookings: BookingDoc[]; reviews: Record<string, unknown>[] }> {
  const customer = await getCollection<CustomerDoc>(Collections.customers).findOne({
    _id: id,
    businessId,
  });
  if (!customer) throw ApiError.notFound("Customer not found");

  const [bookings, reviews] = await Promise.all([
    getCollection<BookingDoc>(Collections.bookings)
      .find({ businessId, customerUserId: customer.userId })
      .sort({ startAt: -1 })
      .limit(25)
      .toArray(),
    getCollection(Collections.reviews)
      .find({ businessId, customerUserId: customer.userId })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray(),
  ]);

  return { customer, bookings, reviews: reviews as Record<string, unknown>[] };
}

/** Appends an internal note. Internal only — never surfaced to the customer. */
export async function addCustomerNote(
  userId: string,
  businessId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ added: true }> {
  const at = isoNow();
  await getCollection<CustomerDoc>(Collections.customers).updateOne(
    { _id: id, businessId },
    {
      $push: { notes: { text: requireString(body.text, "text"), by: userId, at } },
      $set: { updatedAt: at },
    },
  );
  return { added: true };
}

export async function messageCustomer(
  businessId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const customer = await getCollection<CustomerDoc>(Collections.customers).findOne({
    _id: id,
    businessId,
  });
  if (!customer) throw ApiError.notFound("Customer not found");

  return (await sendNotification({
    userId: customer.userId,
    type: "business_message",
    title: requireString(body.title, "title"),
    body: requireString(body.body, "body"),
    data: { businessId, customerId: customer._id },
  })) as Record<string, unknown>;
}

// -------------------------------------------------------------------- staff

/**
 * The team. Permission flags are withheld from a caller acting through their own
 * staff row, so a stylist cannot enumerate what their colleagues may do.
 */
export async function listStaff(
  businessId: string,
  gate: AccessGate,
): Promise<Array<Record<string, unknown>>> {
  const staffDocs = await getCollection<StaffDoc>(Collections.staff)
    .find({ businessId })
    .sort({ displayName: 1 })
    .toArray();

  return staffDocs.map((doc) => ({
    _id: doc._id,
    userId: doc.userId,
    displayName: doc.displayName,
    title: doc.title ?? null,
    role: doc.role,
    avatarUrl: doc.avatarUrl ?? null,
    bio: doc.bio ?? null,
    bookable: doc.bookable === true,
    status: doc.status,
    locationIds: doc.locationIds ?? [],
    serviceIds: doc.serviceIds ?? [],
    workingHours: doc.workingHours ?? {},
    ratingSummary: doc.ratingSummary ?? { average: 0, count: 0 },
    permissions: gate.via === "staff" ? undefined : normalisePermissions(doc.permissions),
  }));
}

export async function addStaffMember(
  businessId: string,
  body: Record<string, unknown>,
): Promise<StaffDoc> {
  const email = requireString(body.email, "email").toLowerCase();

  const existing = await getCollection<StaffDoc>(Collections.staff).findOne({
    businessId,
    inviteEmail: email,
  });
  if (existing) throw ApiError.conflict("That person is already on the team");

  const role = requireString(body.role, "role");
  if (role !== StaffRole.STYLIST && role !== StaffRole.MANAGER && role !== StaffRole.OWNER) {
    throw ApiError.badRequest(`role must be one of ${Object.values(StaffRole).join(", ")}`);
  }

  const at = isoNow();
  const doc: StaffDoc = {
    _id: generateId("stf"),
    businessId,
    locationIds: requireArray(body.locationIds ?? [], "locationIds").map(String),
    userId: typeof body.userId === "string" ? body.userId : "",
    displayName: requireString(body.displayName, "displayName"),
    title: typeof body.title === "string" ? body.title : null,
    role: role as StaffDoc["role"],
    avatarUrl: null,
    bio: typeof body.bio === "string" ? body.bio : null,
    permissions: normalisePermissions(body.permissions),
    workingHours: {},
    serviceIds: requireArray(body.serviceIds ?? [], "serviceIds").map(String),
    commission: { type: "none", value: 0 },
    calendarSync: { provider: null, calendarId: null, enabled: false },
    ratingSummary: { average: 0, count: 0 },
    bookable: true,
    status: "invited",
    inviteEmail: email,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<StaffDoc>(Collections.staff).insertOne(doc);
  return doc;
}

/**
 * Permission flags are owner-only: a manager can edit a stylist's hours but can
 * never grant `viewFinancials` or `processRefunds` to themselves or anyone else.
 */
const STAFF_SERVER_OWNED = ["userId", "businessId", "status", "ratingSummary", "calendarColor"] as const;

export async function updateStaffMember(
  businessId: string,
  gate: AccessGate,
  id: string,
  body: Record<string, unknown>,
): Promise<StaffDoc> {
  const editingPermissions = body.permissions !== undefined;
  if (editingPermissions && gate.via === "staff" && gate.staffRole !== StaffRole.OWNER) {
    throw ApiError.forbidden("Only the business owner can change permission flags");
  }

  const existing = await getCollection<StaffDoc>(Collections.staff).findOne({
    _id: id,
    businessId,
  });
  if (!existing) throw ApiError.notFound("Staff member not found");

  const editable = stripServerOwnedFields<StaffDoc>(body, [...STAFF_SERVER_OWNED]);
  const set: Record<string, unknown> = { ...editable, updatedAt: isoNow() };
  if (editingPermissions) set.permissions = normalisePermissions(body.permissions);

  await getCollection<StaffDoc>(Collections.staff).updateOne(
    { _id: existing._id },
    { $set: set },
  );
  const updated = await getCollection<StaffDoc>(Collections.staff).findOne({ _id: existing._id });
  if (!updated) throw ApiError.notFound("Staff member not found");
  return updated;
}

/** Suspends rather than deletes, so booking history keeps its author. */
export async function suspendStaffMember(
  businessId: string,
  id: string,
): Promise<{ suspended: true }> {
  const existing = await getCollection<StaffDoc>(Collections.staff).findOne({
    _id: id,
    businessId,
  });
  if (!existing) throw ApiError.notFound("Staff member not found");
  if (existing.role === StaffRole.OWNER) {
    throw ApiError.unprocessable("The owner's staff row cannot be removed");
  }

  await getCollection<StaffDoc>(Collections.staff).updateOne(
    { _id: existing._id },
    { $set: { status: "suspended", bookable: false, updatedAt: isoNow() } },
  );
  return { suspended: true };
}

// ----------------------------------------------------------------- services

export async function listServices(businessId: string): Promise<ServiceDoc[]> {
  return getCollection<ServiceDoc>(Collections.services)
    .find({ businessId })
    .sort({ sortOrder: 1 })
    .toArray();
}

export async function createService(
  businessId: string,
  body: Record<string, unknown>,
): Promise<ServiceDoc> {
  // Money and duration are validated here rather than coerced: a price of
  // "12.50" or a zero-minute service would silently break availability.
  const priceMinor = Number(body.priceMinor);
  if (!Number.isInteger(priceMinor) || priceMinor < 0) {
    throw ApiError.badRequest("priceMinor must be a non-negative integer");
  }
  const durationMin = Number(body.durationMin);
  if (!Number.isInteger(durationMin) || durationMin <= 0) {
    throw ApiError.badRequest("durationMin must be a positive integer");
  }

  const at = isoNow();
  const doc: ServiceDoc = {
    _id: generateId("svc"),
    businessId,
    ...(typeof body.categoryId === "string" ? { categoryId: body.categoryId } : {}),
    name: requireString(body.name, "name"),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    durationMin,
    priceMinor,
    currency: "GBP",
    bufferBeforeMin: Number(body.bufferBeforeMin ?? 0),
    bufferAfterMin: Number(body.bufferAfterMin ?? 0),
    staffIds: requireArray(body.staffIds ?? [], "staffIds").map(String),
    locationIds: requireArray(body.locationIds ?? [], "locationIds").map(String),
    staffPricing: [],
    addOns: requireArray(body.addOns ?? [], "addOns") as ServiceDoc["addOns"],
    depositRule: body.depositRule as ServiceDoc["depositRule"],
    instantBook: body.instantBook === true,
    homeService: body.homeService === true,
    rebookCycleDays: (body.rebookCycleDays as ServiceDoc["rebookCycleDays"]) ?? null,
    leadTimeMinutes: Number(body.leadTimeMinutes ?? config.availability.defaultLeadTimeMinutes),
    maxAdvanceDays: Number(body.maxAdvanceDays ?? config.availability.defaultMaxAdvanceDays),
    tags: requireArray(body.tags ?? [], "tags").map(String),
    isActive: body.isActive !== false,
    sortOrder: Number(body.sortOrder ?? 0),
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<ServiceDoc>(Collections.services).insertOne(doc);
  return doc;
}

export async function updateService(
  businessId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<ServiceDoc> {
  const existing = await getCollection<ServiceDoc>(Collections.services).findOne({
    _id: id,
    businessId,
  });
  if (!existing) throw ApiError.notFound("Service not found");

  const editable = stripServerOwnedFields<ServiceDoc>(body, ["businessId"]);
  if (editable.priceMinor !== undefined && !Number.isInteger(editable.priceMinor)) {
    throw ApiError.badRequest("priceMinor must be an integer number of minor units");
  }
  await getCollection<ServiceDoc>(Collections.services).updateOne(
    { _id: existing._id },
    { $set: { ...editable, updatedAt: isoNow() } },
  );
  const updated = await getCollection<ServiceDoc>(Collections.services).findOne({
    _id: existing._id,
  });
  if (!updated) throw ApiError.notFound("Service not found");
  return updated;
}

// ---------------------------------------------------------------- locations

export async function listLocations(businessId: string): Promise<LocationDoc[]> {
  return getCollection<LocationDoc>(Collections.locations).find({ businessId }).toArray();
}

export async function createLocation(
  businessId: string,
  body: Record<string, unknown>,
): Promise<LocationDoc> {
  const at = isoNow();
  const doc: LocationDoc = {
    _id: generateId("loc"),
    businessId,
    name: requireString(body.name, "name"),
    isPrimary: body.isPrimary === true,
    address: (body.address as LocationDoc["address"]) ?? {},
    geo: (body.geo as LocationDoc["geo"]) ?? null,
    phone: typeof body.phone === "string" ? body.phone : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone : "Europe/London",
    openingHours: (body.openingHours as LocationDoc["openingHours"]) ?? {},
    customHours: [],
    amenities: [],
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<LocationDoc>(Collections.locations).insertOne(doc);
  return doc;
}

// --------------------------------------------------------------- promotions

export async function listPromotions(businessId: string): Promise<Record<string, unknown>[]> {
  return (await getCollection(Collections.promotions)
    .find({ businessId })
    .sort({ createdAt: -1 })
    .toArray()) as Record<string, unknown>[];
}

/**
 * `redemptionCount` is server-owned: it increments when a booking actually uses
 * the promotion, never here.
 */
export async function addPromotion(
  userId: string,
  businessId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const discount = requireObject(body.discount, "discount");
  const value = Number(discount.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw ApiError.badRequest("discount.value must be a positive number");
  }
  if (discount.type !== "percentage" && discount.type !== "fixed") {
    throw ApiError.badRequest("discount.type must be 'percentage' or 'fixed'");
  }
  if (discount.type === "percentage" && value > 100) {
    throw ApiError.badRequest("a percentage discount cannot exceed 100");
  }

  const at = isoNow();
  return createPromotion({
    businessId,
    type: requireString(body.type, "type"),
    name: requireString(body.name, "name"),
    discount: { type: discount.type, value },
    rules: (body.rules as Record<string, unknown>) ?? {},
    serviceIds: requireArray(body.serviceIds ?? [], "serviceIds").map(String),
    locationIds: requireArray(body.locationIds ?? [], "locationIds").map(String),
    validFrom: typeof body.validFrom === "string" ? body.validFrom : at,
    validTo: typeof body.validTo === "string" ? body.validTo : null,
    maxRedemptions: typeof body.maxRedemptions === "number" ? body.maxRedemptions : null,
    stackable: body.stackable === true,
    status: body.status === "active" ? "active" : "draft",
    createdBy: userId,
  });
}

/** Pause, resume, or raise the redemption cap. */
export async function updatePromotion(
  businessId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<PromotionDoc> {
  const set: Record<string, unknown> = { updatedAt: isoNow() };
  for (const field of ["name", "validFrom", "validTo", "status", "stackable"] as const) {
    if (body[field] !== undefined) set[field] = body[field];
  }
  if (body.maxRedemptions !== undefined) set.maxRedemptions = body.maxRedemptions;
  if (body.rules !== undefined) set.rules = body.rules;
  if (body.serviceIds !== undefined) {
    set.serviceIds = requireArray(body.serviceIds, "serviceIds").map(String);
  }

  const result = await getCollection<PromotionDoc>(Collections.promotions).updateOne(
    { _id: id, businessId },
    { $set: set },
  );
  if (result.matchedCount === 0) throw ApiError.notFound("Promotion not found");

  const updated = await getCollection<PromotionDoc>(Collections.promotions).findOne({ _id: id });
  if (!updated) throw ApiError.notFound("Promotion not found");
  return updated;
}

export async function getLastMinutePromotion(businessId: string): Promise<unknown> {
  return findBusinessLastMinutePromotion(businessId);
}

// ------------------------------------------------------------------ finance

export async function listPayments(
  businessId: string,
  paging: Paging,
  filters: { status?: string | undefined; from?: string | undefined },
): Promise<{ docs: PaymentDoc[]; total: number }> {
  const filter: Record<string, unknown> = { businessId };
  if (filters.status) filter.status = filters.status;
  if (filters.from) filter.createdAt = { $gte: filters.from };

  const collection = getCollection<PaymentDoc>(Collections.payments);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs, total };
}

/**
 * A stylist holding only `manageCalendar` gets a 403 here, even though they can
 * mark their own appointment attended.
 */
export async function issueRefund(
  businessId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = parseRefundBody(body);
  const result = await refundPayment({
    paymentId: requireString(body.paymentId, "paymentId"),
    businessId,
    ...(parsed.amountMinor !== undefined ? { amountMinor: parsed.amountMinor } : {}),
    reason: parsed.reason,
  });
  return {
    refundId: result.refundId,
    amountMinor: result.amountMinor,
    status: result.payment.status,
  };
}

export async function listPayouts(businessId: string): Promise<Record<string, unknown>[]> {
  return (await getCollection(Collections.payouts)
    .find({ businessId })
    .sort({ periodEnd: -1 })
    .limit(100)
    .toArray()) as Record<string, unknown>[];
}

// ----------------------------------------------------------------- disputes

export async function listDisputes(businessId: string): Promise<DisputeDoc[]> {
  return getCollection<DisputeDoc>(Collections.disputes)
    .find({ businessId })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
}

/** Adds the business's evidence to the dispute timeline. */
export async function respondToDispute(
  userId: string,
  businessId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ responded: true }> {
  const at = isoNow();
  const result = await getCollection<DisputeDoc>(Collections.disputes).updateOne(
    { _id: id, businessId },
    {
      $push: {
        evidence: {
          by: userId,
          note: requireString(body.note, "note"),
          url: typeof body.url === "string" ? body.url : "",
        },
      },
      $set: { status: "under_review", updatedAt: at },
    },
  );
  if (result.matchedCount === 0) throw ApiError.notFound("Dispute not found");
  return { responded: true };
}

// ------------------------------------------------------------------ reviews

export async function listBusinessReviews(
  businessId: string,
  paging: Paging,
  status?: string | undefined,
): Promise<{ docs: ReviewDoc[]; total: number }> {
  const filter: Record<string, unknown> = { businessId };
  if (status) filter.status = status;

  const collection = getCollection<ReviewDoc>(Collections.reviews);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs, total };
}

// ------------------------------------------------------------ trust & scores

/**
 * On-demand recompute of the score and badges. The same functions run nightly;
 * both stay server-owned regardless of who triggers them.
 */
export async function recomputeScoreAndBadges(businessId: string): Promise<Record<string, unknown>> {
  const result = await computeBusinessScore(businessId);
  return { score: await persistBusinessScore(result), badges: await recomputeBadges(businessId) };
}

export async function recomputeInsights(businessId: string): Promise<unknown> {
  return recomputeCustomerInsights(businessId);
}

// ---------------------------------------------------------------- portfolio

export async function listPortfolio(
  businessId: string,
  gate: AccessGate,
): Promise<Record<string, unknown>[]> {
  const filter: Record<string, unknown> = { businessId, status: "published" };
  if (gate.selfOnly) filter.staffId = gate.staffId;
  return (await getCollection(Collections.portfolioItems)
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(60)
    .toArray()) as Record<string, unknown>[];
}

export async function addPortfolioItem(
  businessId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = isoNow();
  const doc = {
    _id: generateId("pfi"),
    businessId,
    staffId: typeof body.staffId === "string" ? body.staffId : null,
    locationId: typeof body.locationId === "string" ? body.locationId : null,
    mediaType: requireString(body.mediaType, "mediaType"),
    media: requireString(body.media, "media"),
    caption: typeof body.caption === "string" ? body.caption : null,
    serviceIds: requireArray(body.serviceIds ?? [], "serviceIds").map(String),
    tags: requireArray(body.tags ?? [], "tags").map(String),
    displayPriceMinor: typeof body.displayPriceMinor === "number" ? body.displayPriceMinor : null,
    publishToDiscovery: body.publishToDiscovery === true,
    bookThisLook: body.bookThisLook === true,
    counts: { likes: 0, views: 0, saves: 0 },
    status: body.status === "published" ? "published" : "draft",
    createdAt: at,
    updatedAt: at,
  };
  await getCollection(Collections.portfolioItems).insertOne(doc);
  return doc;
}

// -------------------------------------------------------------- audit trail

/**
 * Admin actions that touched this business. Read-only here, and written
 * exclusively by the admin module.
 */
export async function listBusinessAuditLogs(
  businessId: string,
  paging: Paging,
): Promise<{ docs: Record<string, unknown>[]; total: number }> {
  const collection = getCollection(Collections.adminActionLogs);
  const filter = { "details.businessId": businessId };
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ at: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { docs: docs as Record<string, unknown>[], total };
}
