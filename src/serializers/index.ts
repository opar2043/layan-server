import type { Request } from "express";
import { ApiError } from "../shared/errors";
import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import type { BookingDoc, ReviewDoc, StaffPermissions, UserDoc } from "../types/domain";
import { UserRole } from "../types/enums";

/**
 * Field-level redaction, §2 of the master prompt. A booking is one document with
 * one source of truth; what changes between callers is only what they may see.
 */
export interface RedactionContext {
  role: UserRole;
  permissions: StaffPermissions | null;
  /** Set when a stylist is looking at their own calendar. */
  isSelfStaff: boolean;
}

export function redactionContext(req: Request): RedactionContext {
  const role = req.auth?.user.role ?? UserRole.CUSTOMER;
  return {
    role,
    permissions: req.staffPermissions ?? null,
    isSelfStaff: req.businessAccess?.selfOnly === true,
  };
}

/** Does this caller get to see money on a booking? */
export function canViewFinancials(ctx: RedactionContext): boolean {
  if (ctx.role === UserRole.ADMIN) return true;
  if (ctx.role === UserRole.BUSINESS_OWNER) return true;
  if (ctx.role === UserRole.STAFF) return ctx.permissions?.viewFinancials === true;
  return false;
}

const INTERNAL_BOOKING_FIELDS = [
  "slotKey",
  "slotActive",
  "resourceId",
  "pricing.commissionMinor",
] as const;

function omit(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  for (const key of keys) delete out[key];
  return out;
}

function pick<T>(source: Record<string, unknown>, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as T;
}

export interface CustomerBookingView {
  _id: string;
  bookingRef: string;
  businessId: string;
  locationId: string;
  staffId: string;
  customerUserId: string;
  items: unknown;
  startAt: string;
  endAt: string;
  status: string;
  /** Redacted to a single total unless the caller may see financials. */
  pricing: { subtotalMinor: number; discountMinor: number; tipMinor: number; totalMinor: number } | { totalMinor: number; currency?: string };
  deposit: { required: boolean; amountMinor: number; status: string };
  policySnapshot: unknown;
  policyAgreedAt: string;
  orderId: string | null;
  reviewId: string | null;
  instantSlotId: string | null;
  promotionId: string | null;
  notes: string | null;
  statusHistory: unknown;
  cancellation: unknown;
  rescheduledFrom: unknown;
  isVerifiedReviewable: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The single booking serializer. Every role gets the same document; only the
 * private fields differ.
 *
 * - customer      → no `staffPricing` internals, no commission, no payout, no resource
 * - stylist       → no money breakdown at all (no `viewFinancials`), and nothing about
 *                   other staff members' bookings
 * - manager/owner → full financials, still no cross-business leakage
 * - admin         → full
 */
export function serializeBooking(
  booking: BookingDoc,
  ctx: RedactionContext,
): Record<string, unknown> {
  const raw = booking as unknown as Record<string, unknown>;
  const financials = canViewFinancials(ctx);

  const base = omit(raw, INTERNAL_BOOKING_FIELDS);

  if (!financials) {
    // Strip staff-level price overrides from the line items: a customer booking a
    // specific stylist must not learn that staff member's private price list.
    const items = Array.isArray(raw.items)
      ? (raw.items as Array<Record<string, unknown>>).map((item) =>
          omit(item, ["staffPricing", "commissionMinor", "costMinor"]),
        )
      : raw.items;
    return {
      ...base,
      items,
      pricing: { totalMinor: (raw.pricing as { totalMinor?: number } | undefined)?.totalMinor ?? 0 },
      deposit: {
        required: (raw.deposit as { required?: boolean } | undefined)?.required === true,
        amountMinor: (raw.deposit as { amountMinor?: number } | undefined)?.amountMinor ?? 0,
        status: (raw.deposit as { status?: string } | undefined)?.status ?? "none",
      },
      isVerifiedReviewable: booking.status === "attended" && !booking.reviewId,
    };
  }

  return {
    ...base,
    deposit: {
      required: booking.deposit.required,
      amountMinor: booking.deposit.amountMinor,
      paymentId: booking.deposit.paymentId,
      status: booking.deposit.status,
    },
    cancellation: booking.cancellation ?? null,
    isVerifiedReviewable: booking.status === "attended" && !booking.reviewId,
  };
}

const USER_PUBLIC_FIELDS = [
  "_id",
  "firstName",
  "lastName",
  "avatarUrl",
  "gender",
  "referralCode",
] as const;
const USER_SELF_FIELDS = [
  ...USER_PUBLIC_FIELDS,
  "email",
  "phone",
  "dateOfBirth",
  "status",
  "emailVerified",
  "phoneVerified",
  "marketingConsent",
  "deviceTokens",
  "homeLocation",
  "preferences",
  "role",
  "adminRole",
  "lastLoginAt",
  "createdAt",
] as const;

/** `passwordHash` is never included in any branch. */
export function serializeUser(
  user: UserDoc,
  opts: { self: boolean },
): Record<string, unknown> {
  return pick(user as unknown as Record<string, unknown>, opts.self ? USER_SELF_FIELDS : USER_PUBLIC_FIELDS);
}

export function serializeUsers(users: UserDoc[]): Array<Record<string, unknown>> {
  return users.map((user) => serializeUser(user, { self: false }));
}

/**
 * A customer sees their own wallet. A business sees wallet data only for a customer
 * they have an active relationship with, and never the saved-card tokens.
 */
export function serializeWallet(
  wallet: Record<string, unknown>,
  ctx: RedactionContext,
): Record<string, unknown> {
  const savedCards = Array.isArray(wallet.savedCards) ? wallet.savedCards : [];
  return {
    ...wallet,
    savedCards: savedCards.map((card) => {
      const raw = card as Record<string, unknown>;
      return pick(raw, ["brand", "last4", "expMonth", "expYear", "isDefault"]);
    }),
    ...(ctx.role === UserRole.CUSTOMER ? {} : { userId: wallet.userId }),
  };
}

/** `isVerifiedBooking` is server-derived, so it is always safe to expose. */
export function serializeReview(review: ReviewDoc): Record<string, unknown> {
  const raw = review as unknown as Record<string, unknown>;
  return {
    ...raw,
    moderation: { flagged: review.moderation?.flagged === true, score: review.moderation?.score ?? 0 },
  };
}

export function serializeReviews(reviews: ReviewDoc[]): Array<Record<string, unknown>> {
  return reviews.map(serializeReview);
}

export interface CustomerProfileView extends Record<string, unknown> {
  /** Server-computed insight block, present for the business side, hidden from the customer. */
  insights?: unknown;
}

/**
 * CRM customer record. `insights` is a nightly-computed internal field — the
 * business sees it, the customer never does (their own rebooking prompts surface
 * through `/api/customer/rebooking/prompts` instead).
 */
export function serializeCustomerRecord(
  customer: Record<string, unknown>,
  ctx: RedactionContext,
): CustomerProfileView {
  const base = { ...customer };
  if (ctx.role === UserRole.CUSTOMER) {
    delete base.insights;
  }
  return base;
}

/** Guard used by controllers that must not trust a body/param `customerId`. */
export async function assertOwnBooking(
  bookingId: string,
  userId: string,
): Promise<BookingDoc> {
  const booking = await getCollection<BookingDoc>(Collections.bookings).findOne({
    _id: bookingId,
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (booking.customerUserId !== userId) {
    // Do not disclose existence across accounts.
    throw ApiError.forbidden("This booking belongs to another account");
  }
  return booking;
}
