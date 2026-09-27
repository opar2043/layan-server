import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";

/** Six 1-5 scores. `overall` is mandatory; the rest default to `overall` when omitted. */
export interface ReviewRatings {
  overall: number;
  service: number;
  cleanliness: number;
  value: number;
  professionalism: number;
  punctuality: number;
}

/**
 * A review is only accepted for a booking the customer actually attended, and the
 * unique index on `bookingId` makes that a one-review-per-appointment rule.
 */
export interface IReview extends Document {
  bookingId: Document["_id"];
  customerId: Document["_id"];
  businessId: Document["_id"];
  ratings: ReviewRatings;
  comment?: string;
  businessReply?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const ReviewModel = () => getCollection<IReview>(COLLECTIONS.REVIEWS);

export const RATING_FIELDS = [
  "service",
  "cleanliness",
  "value",
  "professionalism",
  "punctuality",
] as const;

export default ReviewModel;
