import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { addDays, generateId, isoNow } from "../shared/utils";
import type {
  BadgeAwardDoc,
  BookingDoc,
  BusinessDoc,
  FraudFlagDoc,
  ReviewDoc,
  StaffDoc,
} from "../types/domain";
import { BookingStatus } from "../types/enums";

interface BadgeCriterion {
  badgeKey: string;
  staffId?: string | null;
  criteria: Record<string, unknown>;
  validUntil: string;
}

/**
 * Badges are **computed, never client-settable**. There is no API route that
 * writes a computed badge; only this function and the admin verification workflow
 * touch `badgeAwards`.
 */
export async function recomputeBadges(
  businessId: string,
  now = new Date(),
): Promise<{ awarded: string[]; revoked: string[] }> {
  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: businessId,
  });
  if (!business) return { awarded: [], revoked: [] };

  const ninetyDaysAgo = addDays(now, -90);
  const [bookings, reviews, staffDocs] = await Promise.all([
    getCollection<BookingDoc>(Collections.bookings)
      .find({ businessId, startAt: { $gte: ninetyDaysAgo.toISOString() } })
      .toArray(),
    getCollection<ReviewDoc>(Collections.reviews)
      .find({ businessId, status: "published" })
      .toArray(),
    getCollection<StaffDoc>(Collections.staff).find({ businessId, status: "active" }).toArray(),
  ]);

  const cancelled = bookings.filter(
    (booking) =>
      booking.status === BookingStatus.LATE_CANCEL || booking.status === BookingStatus.NO_SHOW,
  ).length;
  const cancellationRate = bookings.length === 0 ? 1 : cancelled / bookings.length;
  const validUntil = addDays(now, 90).toISOString();

  const wanted: BadgeCriterion[] = [];
  const ratingCount = business.ratingSummary?.count ?? reviews.length;
  const ratingAverage = business.ratingSummary?.average ?? 0;

  if (ratingAverage >= 4.8 && ratingCount >= 50 && cancellationRate <= 0.05) {
    wanted.push({
      badgeKey: "layan_top_professional",
      staffId: null,
      criteria: { rating: ratingAverage, reviews: ratingCount, cancellationRate },
      validUntil,
    });
  }

  for (const staff of staffDocs) {
    const staffBookings = bookings.filter((booking) => booking.staffId === staff._id);
    if (staffBookings.length >= 10) {
      const byCustomer = new Map<string, number>();
      for (const booking of staffBookings) {
        byCustomer.set(booking.customerUserId, (byCustomer.get(booking.customerUserId) ?? 0) + 1);
      }
      const rebookRate =
        [...byCustomer.values()].filter((count) => count > 1).length / byCustomer.size;
      if (rebookRate >= 0.5) {
        wanted.push({
          badgeKey: "highly_rebooked",
          staffId: staff._id,
          criteria: { rebookRate: Math.round(rebookRate * 100) / 100, minAppointments: staffBookings.length },
          validUntil,
        });
      }
    }
  }

  if (business.channels?.websiteWidget === true || business.channels?.instagram === true) {
    const conversations = await getCollection(Collections.conversations)
      .find({ businessId })
      .toArray();
    if (conversations.length >= 5) {
      wanted.push({
        badgeKey: "fast_responder",
        staffId: null,
        criteria: { conversationCount: conversations.length },
        validUntil,
      });
    }
  }

  if (business.instantBook === true) {
    wanted.push({
      badgeKey: "instant_book_enabled",
      staffId: null,
      criteria: { instantBook: true },
      validUntil,
    });
  }

  const awards = getCollection<BadgeAwardDoc>(Collections.badgeAwards);
  const current = await awards
    .find({ businessId, status: "active" })
    .toArray();
  const at = isoNow();

  const awarded: string[] = [];
  const revoked: string[] = [];

  for (const criterion of wanted) {
    const match = current.find(
      (award) => award.badgeKey === criterion.badgeKey && (award.staffId ?? null) === (criterion.staffId ?? null),
    );
    if (match) {
      await awards.updateOne(
        { _id: match._id },
        { $set: { criteria: criterion.criteria, validUntil: criterion.validUntil, updatedAt: at } },
      );
      continue;
    }
    await awards.insertOne({
      _id: generateId("bdg"),
      businessId,
      staffId: criterion.staffId ?? null,
      badgeKey: criterion.badgeKey,
      criteria: criterion.criteria,
      awardedAt: at,
      validUntil: criterion.validUntil,
      status: "active",
      createdAt: at,
      updatedAt: at,
    } satisfies BadgeAwardDoc);
    awarded.push(criterion.badgeKey);
  }

  for (const award of current) {
    const stillWanted = wanted.some(
      (criterion) =>
        criterion.badgeKey === award.badgeKey &&
        (criterion.staffId ?? null) === (award.staffId ?? null),
    );
    if (stillWanted) continue;
    await awards.updateOne(
      { _id: award._id },
      { $set: { status: "expired", updatedAt: at } },
    );
    revoked.push(award.badgeKey);
  }

  const activeKeys = wanted.map((criterion) => criterion.badgeKey);
  await getCollection(Collections.businesses).updateOne(
    { _id: businessId },
    { $set: { badges: activeKeys, updatedAt: at } },
  );

  return { awarded, revoked };
}

export interface FraudSignal {
  type: string;
  severity: FraudFlagDoc["severity"];
  targetType: string;
  targetId: string;
  businessId: string | null;
  signals: Array<Record<string, unknown>>;
}

async function raiseFlag(signal: FraudSignal, now: Date): Promise<string | null> {
  const flags = getCollection<FraudFlagDoc>(Collections.fraudFlags);
  const existing = await flags.findOne({
    type: signal.type,
    targetType: signal.targetType,
    targetId: signal.targetId,
    status: { $in: ["open", "investigating", "restricted"] },
  });
  if (existing) return null;

  const at = isoNow();
  const doc: FraudFlagDoc = {
    _id: generateId("frd"),
    type: signal.type,
    severity: signal.severity,
    targetType: signal.targetType,
    targetId: signal.targetId,
    businessId: signal.businessId,
    signals: signal.signals,
    status: "open",
    detectedBy: "system",
    assignedTo: null,
    actions: [],
    createdAt: at,
    updatedAt: at,
  };
  await flags.insertOne(doc);
  void now;
  return doc._id;
}

/**
 * Automatic fraud detection. Raises a flag; only an admin ever investigates or
 * resolves. Runs nightly and after every review write.
 */
export async function detectFraud(
  options: { businessId?: string; now?: Date } = {},
): Promise<FraudFlagDoc[]> {
  const now = options.now ?? new Date();
  const created: FraudFlagDoc[] = [];
  const flags = getCollection<FraudFlagDoc>(Collections.fraudFlags);

  // 1. Three or more chargebacks / disputes in 90 days against one user.
  const cutoff = addDays(now, -90);
  const recentDisputes = await getCollection(Collections.disputes)
    .find({ type: "chargeback", createdAt: { $gte: cutoff.toISOString() } })
    .toArray();

  const byUser = new Map<string, number>();
  for (const dispute of recentDisputes) {
    const paymentId = typeof dispute.paymentId === "string" ? dispute.paymentId : null;
    if (!paymentId) continue;
    const payment = await getCollection(Collections.payments).findOne({ _id: paymentId });
    if (!payment) continue;
    const userId = String(payment.customerUserId);
    byUser.set(userId, (byUser.get(userId) ?? 0) + 1);
  }

  for (const [userId, count] of byUser) {
    if (count < 3) continue;
    const id = await raiseFlag(
      {
        type: "repeated_chargebacks",
        severity: "high",
        targetType: "user",
        targetId: userId,
        businessId: null,
        signals: [{ name: "chargebacks_last_90d", value: count }],
      },
      now,
    );
    if (id) {
      const doc = await flags.findOne({ _id: id });
      if (doc) created.push(doc);
    }
  }

  // 2. A review written by an account that owns a competing business.
  const heldReviews = await getCollection<ReviewDoc>(Collections.reviews)
    .find({ status: "under_review" })
    .toArray();
  for (const review of heldReviews) {
    const competing = await getCollection(Collections.businesses).findOne({
      ownerId: review.customerUserId,
    });
    if (!competing || competing._id === review.businessId) continue;
    const id = await raiseFlag(
      {
        type: "review_manipulation",
        severity: "medium",
        targetType: "review",
        targetId: review._id,
        businessId: review.businessId,
        signals: [
          { name: "reviewer_owns_competing_business", weight: 0.6, businessId: competing._id },
          ...(review.moderation?.reason ? [{ reason: review.moderation.reason }] : []),
        ],
      },
      now,
    );
    if (id) {
      const doc = await flags.findOne({ _id: id });
      if (doc) created.push(doc);
    }
  }

  // 3. Excessive same-day cancellations by one customer at one business.
  const businessFilter: Record<string, unknown> = {};
  if (options.businessId) businessFilter.businessId = options.businessId;
  const bookings = await getCollection<BookingDoc>(Collections.bookings)
    .find({ ...businessFilter, status: { $in: [BookingStatus.LATE_CANCEL, BookingStatus.CANCELLED] } })
    .toArray();

  const windowStart = addDays(now, -7).getTime();
  const byCustomer = new Map<string, BookingDoc[]>();
  for (const booking of bookings) {
    const cancelledAt = booking.cancellation?.at;
    if (!cancelledAt) continue;
    const at = new Date(cancelledAt).getTime();
    if (at < windowStart) continue;
    const startAt = new Date(booking.startAt).getTime();
    // "Same-day" means cancelled within 24h of the appointment starting.
    if (startAt - at > 24 * 3_600_000) continue;
    const list = byCustomer.get(booking.customerUserId) ?? [];
    list.push(booking);
    byCustomer.set(booking.customerUserId, list);
  }

  for (const [userId, list] of byCustomer) {
    if (list.length < 3) continue;
    const businessId = String(list[0]?.businessId ?? "");
    const id = await raiseFlag(
      {
        type: "excessive_same_day_cancellations",
        severity: "medium",
        targetType: "user",
        targetId: userId,
        businessId: businessId || null,
        signals: [
          { name: "same_day_cancellations_last_7d", value: list.length },
          { name: "bookingIds", value: list.map((booking) => booking._id) },
        ],
      },
      now,
    );
    if (id) {
      const doc = await flags.findOne({ _id: id });
      if (doc) created.push(doc);
    }
  }

  return created;
}
