import { Filter, ObjectId } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated } from "../../shared/helpers";
import { populateMany } from "../../shared/populate";
import { COLLECTIONS } from "../../shared/db";
import { optionalString, requireNumber, toObjectId } from "../../shared/validate";
import { JwtPayload } from "../../types";
import { ReviewModel, ReviewRatings } from "./model";
import { BookingModel, IBooking } from "../bookings/model";
import { findCustomerIdByFirebaseUid } from "../users/users";
import { resolveActor } from "../../shared/identify.middleware";

/**
 * POST /api/reviews — customer reviews an attended booking.
 *
 * Three gates, all required:
 *   1. the booking belongs to the caller;
 *   2. the booking is flagged isVerifiedReviewEligible (set when it became `attended`);
 *   3. no review exists yet for that booking (also enforced by a unique index).
 */
export async function createReview(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const actor = await resolveActor({ firebaseUid }, findCustomerIdByFirebaseUid);
  if (!actor.customerId) {
    throw ApiError.forbidden("Only customers can leave a review");
  }

  const bookingId = body.bookingId
    ? toObjectId(body.bookingId, "bookingId")
    : null;
  if (!bookingId) throw ApiError.badRequest('"bookingId" is required');

  const comment = optionalString(body, "comment", { max: 4000 });
  const ratingsSource =
    body.ratings && typeof body.ratings === "object" && !Array.isArray(body.ratings)
      ? (body.ratings as Record<string, unknown>)
      : null;
  if (!ratingsSource) {
    throw ApiError.badRequest('"ratings" is required and must be an object');
  }

  const overall = requireNumber(ratingsSource, "overall", { min: 1, max: 5 });

  // Sub-scores are optional: any the customer skips inherits `overall`.
  const subScore = (field: string): number => {
    const value = ratingsSource[field];
    if (value === undefined || value === null) return overall;
    return requireNumber(ratingsSource, field, { min: 1, max: 5 });
  };

  const ratings: ReviewRatings = {
    overall,
    service: subScore("service"),
    cleanliness: subScore("cleanliness"),
    value: subScore("value"),
    professionalism: subScore("professionalism"),
    punctuality: subScore("punctuality"),
  };

  const bookings = BookingModel();
  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking) throw ApiError.notFound("Booking not found");

  const typedBooking = booking as IBooking;

  if (typedBooking.customerId.toHexString() !== actor.customerId) {
    throw ApiError.forbidden("You can only review your own bookings");
  }
  if (!typedBooking.isVerifiedReviewEligible) {
    throw ApiError.badRequest(
      "This booking is not review-eligible — a review can only be left after the appointment is marked attended"
    );
  }

  const reviews = ReviewModel();
  const existing = await reviews.findOne({ bookingId }, { projection: { _id: 1 } });
  if (existing) {
    throw ApiError.conflict("A review already exists for this booking");
  }

  const now = new Date();
  const document = {
    bookingId,
    customerId: typedBooking.customerId,
    businessId: typedBooking.businessId,
    ratings,
    comment,
    createdAt: now,
    updatedAt: now,
  };

  let result;
  try {
    result = await reviews.insertOne(document);
  } catch {
    // Lost the race against the unique bookingId index.
    throw ApiError.conflict("A review already exists for this booking");
  }

  const created = await reviews.findOne({ _id: result.insertedId });
  const [item] = await populateMany(created ? [created] : [], [
    { field: "customerId", collection: COLLECTIONS.USERS, select: ["name"] },
  ]);

  return sendSuccess(res, 201, "Review submitted", { review: item });
}

/** GET /api/reviews?businessId= — public, newest first, customer name inlined. */
export async function listReviews(query: Record<string, unknown>, res: Response) {
  const pagination = getPagination(query);

  if (typeof query.businessId !== "string" || !query.businessId) {
    throw ApiError.badRequest('"businessId" query parameter is required');
  }

  const filter: Filter<Record<string, unknown>> = {
    businessId: toObjectId(query.businessId, "business id"),
  };

  const reviews = ReviewModel();
  const [docs, total] = await Promise.all([
    reviews.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).toArray(),
    reviews.countDocuments(filter),
  ]);

  return sendPaginated(
    res,
    "Reviews retrieved",
    await populateMany(docs, [
      { field: "customerId", collection: COLLECTIONS.USERS, select: ["name"] },
    ]),
    total,
    pagination
  );
}

/** PATCH /api/reviews/:id/reply — the reviewed business posts a public reply. */
export async function replyToReview(
  auth: JwtPayload,
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const businessId = auth.businessId ?? auth.id;
  if (!businessId) throw ApiError.forbidden("Token does not carry a business scope");

  const reviews = ReviewModel();
  const review = await reviews.findOne({ _id: toObjectId(params.id, "review id") });
  if (!review) throw ApiError.notFound("Review not found");

  const businessIdHex = (review as { businessId: ObjectId }).businessId.toHexString();
  if (businessIdHex !== businessId) {
    throw ApiError.forbidden("You can only reply to reviews for your own business");
  }

  const reply = optionalString(body, "businessReply", { max: 2000 });
  if (!reply) {
    throw ApiError.badRequest('"businessReply" is required and must be a non-empty string');
  }

  await reviews.updateOne(
    { _id: (review as { _id: ObjectId })._id },
    { $set: { businessReply: reply, updatedAt: new Date() } }
  );

  const updated = await reviews.findOne({ _id: (review as { _id: ObjectId })._id });
  const [item] = await populateMany(updated ? [updated] : [], [
    { field: "customerId", collection: COLLECTIONS.USERS, select: ["name"] },
  ]);

  return sendSuccess(res, 200, "Reply posted", { review: item });
}

export default { createReview, listReviews, replyToReview };
