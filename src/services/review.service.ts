import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { ApiError } from "../shared/errors";
import { generateId, isoNow } from "../shared/utils";
import type { BookingDoc, ReviewDoc, StaffDoc } from "../types/domain";
import { BookingStatus } from "../types/enums";
import { sendNotification } from "./notification.service";

export interface CreateReviewInput {
  customerUserId: string;
  bookingId: string;
  ratings: Record<string, number>;
  comment?: string;
  photos?: string[];
}

const REQUIRED_RATINGS = ["overall"] as const;
const OPTIONAL_RATINGS = ["service", "cleanliness", "value", "professionalism", "punctuality"];

/**
 * A review may only exist for an attended booking, one review per booking, and
 * `isVerifiedBooking` is derived here — never accepted from the client.
 */
export async function createReview(input: CreateReviewInput): Promise<ReviewDoc> {
  const reviews = getCollection<ReviewDoc>(Collections.reviews);
  const booking = await getCollection<BookingDoc>(Collections.bookings).findOne({
    _id: input.bookingId,
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  if (booking.customerUserId !== input.customerUserId) {
    throw ApiError.forbidden("This booking belongs to another account");
  }
  if (booking.status !== BookingStatus.ATTENDED) {
    throw ApiError.unprocessable("You can only review an appointment you attended", {
      status: booking.status,
    });
  }

  const existing = await reviews.findOne({ bookingId: booking._id });
  if (existing) throw ApiError.conflict("You have already reviewed this appointment");

  for (const key of REQUIRED_RATINGS) {
    const value = input.ratings[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) {
      throw ApiError.badRequest(`ratings.${key} must be a number between 1 and 5`);
    }
  }
  for (const [key, value] of Object.entries(input.ratings)) {
    if (![...REQUIRED_RATINGS, ...OPTIONAL_RATINGS].includes(key as never)) {
      throw ApiError.badRequest(`Unknown rating "${key}"`);
    }
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      throw ApiError.badRequest(`ratings.${key} must be between 1 and 5`);
    }
  }

  const at = isoNow();
  const moderation = await moderateReview(booking, input.comment ?? "");

  const review: ReviewDoc = {
    _id: generateId("rev"),
    bookingId: booking._id,
    businessId: booking.businessId,
    staffId: booking.staffId,
    serviceId: booking.items[0]?.serviceId ?? "",
    customerUserId: input.customerUserId,
    ratings: input.ratings,
    comment: input.comment ?? "",
    photos: input.photos ?? [],
    isVerifiedBooking: true,
    businessReply: null,
    status: moderation.flagged ? "under_review" : "published",
    moderation: {
      flagged: moderation.flagged,
      score: moderation.score,
      ...(moderation.reason === undefined ? {} : { reason: moderation.reason }),
    },
    createdAt: at,
    updatedAt: at,
  };

  await reviews.insertOne(review);
  await getCollection<BookingDoc>(Collections.bookings).updateOne(
    { _id: booking._id },
    { $set: { reviewId: review._id, updatedAt: at } },
  );

  if (!moderation.flagged) {
    await refreshRatingSummaries(review);
    await awardLoyaltyPointsForReview(review);
  }

  return review;
}

/**
 * A review written by someone who owns a competing business is held for review
 * and raises a fraud flag rather than publishing.
 */
async function moderateReview(
  booking: BookingDoc,
  comment: string,
): Promise<{ flagged: boolean; score: number; reason?: string }> {
  let score = 0.02;
  const reasons: string[] = [];

  const reviewerOwnsBusiness = await getCollection(Collections.businesses).findOne({
    ownerId: booking.customerUserId,
  });
  if (reviewerOwnsBusiness) {
    score = 0.81;
    reasons.push("reviewer owns a competing business");
  }

  const hoursSinceBooking =
    (Date.now() - new Date(booking.startAt).getTime()) / 3_600_000;
  if (hoursSinceBooking < 24) {
    score = Math.max(score, 0.45);
    reasons.push("review submitted same day as the appointment");
  }

  if (comment.trim().length === 0 && (booking.pricing.tipMinor ?? 0) > 0) {
    score = Math.max(score, 0.3);
    reasons.push("empty review on a tipped booking");
  }

  const flagged = score >= 0.4;
  return {
    flagged,
    score: Math.round(score * 100) / 100,
    ...(reasons.length > 0 ? { reason: reasons.join(", ") } : {}),
  };
}

export async function replyToReview(
  reviewId: string,
  businessId: string,
  message: string,
  actorId: string,
): Promise<ReviewDoc> {
  const reviews = getCollection<ReviewDoc>(Collections.reviews);
  const at = isoNow();
  const updated = await reviews.findOneAndUpdate(
    { _id: reviewId, businessId },
    { $set: { businessReply: { message, repliedAt: at, by: actorId }, updatedAt: at } },
    { returnDocument: "after" },
  );
  if (!updated) throw ApiError.notFound("Review not found");
  await sendNotification({
    userId: updated.customerUserId,
    type: "review_reply",
    title: `${String(updated.businessId)} replied to your review`,
    body: message.slice(0, 140),
    data: { reviewId },
  });
  return updated;
}

export async function refreshRatingSummaries(review: ReviewDoc): Promise<void> {
  const businessReviews = await getCollection<ReviewDoc>(Collections.reviews)
    .find({ businessId: review.businessId, status: "published" })
    .toArray();
  if (businessReviews.length > 0) {
    const breakdown: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    let total = 0;
    for (const row of businessReviews) {
      const score = row.ratings.overall ?? 0;
      breakdown[String(score)] = (breakdown[String(score)] ?? 0) + 1;
      total += score;
    }
    await getCollection(Collections.businesses).updateOne(
      { _id: review.businessId },
      {
        $set: {
          "ratingSummary.average": Math.round((total / businessReviews.length) * 10) / 10,
          "ratingSummary.count": businessReviews.length,
          "ratingSummary.breakdown": breakdown,
          updatedAt: isoNow(),
        },
      },
    );
  }

  const staffReviews = businessReviews.filter((row) => row.staffId === review.staffId);
  if (staffReviews.length > 0) {
    const total = staffReviews.reduce((sum, row) => sum + (row.ratings.overall ?? 0), 0);
    await getCollection<StaffDoc>(Collections.staff).updateOne(
      { _id: review.staffId },
      {
        $set: {
          "ratingSummary.average": Math.round((total / staffReviews.length) * 10) / 10,
          "ratingSummary.count": staffReviews.length,
          updatedAt: isoNow(),
        },
      },
    );
  }
}

async function awardLoyaltyPointsForReview(review: ReviewDoc): Promise<void> {
  const at = isoNow();
  const program = await getCollection(Collections.loyaltyPrograms).findOne({
    businessId: review.businessId,
    status: "active",
  });
  if (!program) return;

  const rule = (Array.isArray(program.earnRules) ? program.earnRules : []).find(
    (entry: { type?: string }) => entry.type === "review",
  );
  const points = typeof rule?.points === "number" ? rule.points : 0;
  if (points <= 0) return;

  const wallets = getCollection(Collections.wallets);
  const wallet = await wallets.findOne({ userId: review.customerUserId });
  const ledger = Array.isArray(wallet?.loyaltyPoints)
    ? (wallet!.loyaltyPoints as Array<{ businessId: string; points: number }>)
    : [];
  const current = ledger.find((row) => row.businessId === review.businessId)?.points ?? 0;
  const balanceAfter = current + points;
  const nextLedger = ledger.some((row) => row.businessId === review.businessId)
    ? ledger.map((row) =>
        row.businessId === review.businessId ? { ...row, points: balanceAfter } : row,
      )
    : [...ledger, { businessId: review.businessId, points: balanceAfter }];

  if (wallet) {
    await wallets.updateOne(
      { _id: wallet._id },
      { $set: { loyaltyPoints: nextLedger, updatedAt: at } },
    );
  }

  await getCollection(Collections.loyaltyTransactions).insertOne({
    _id: generateId("lty"),
    businessId: review.businessId,
    programId: program._id,
    userId: review.customerUserId,
    type: "earn",
    points,
    balanceAfter,
    refType: "review",
    refId: review._id,
    note: `Earned for a ${review.ratings.overall}-star review`,
    createdAt: at,
    updatedAt: at,
  });
}
