import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { BookingStatus, PaymentMethod } from "../../types/enums";

/**
 * The shared source of truth. Reviews, wallet ledger entries and disputes all
 * reference a booking, so its lifecycle states drive the rest of the marketplace.
 */
export interface IBooking extends Document {
  customerId: Document["_id"];
  businessId: Document["_id"];
  /** Absent when the customer picks "any available staff member". */
  staffId?: Document["_id"];
  serviceId: Document["_id"];
  startTime: Date;
  /** Derived from the service duration at creation time and stored, so history survives edits. */
  endTime: Date;
  status: BookingStatus;
  depositAmount: number;
  /** Price at the time of booking — never recomputed from the live service. */
  totalPrice: number;
  amountPaid: number;
  tip: number;
  paymentMethod?: PaymentMethod;
  /** Free-form service-specific answers (Mongoose `mixed`). */
  consultationForm?: Record<string, unknown>;
  /** Set true when status becomes `attended`; gates the one-review-per-booking rule. */
  isVerifiedReviewEligible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const BookingModel = () => getCollection<IBooking>(COLLECTIONS.BOOKINGS);

/**
 * Statuses that still occupy a slot in the diary. A cancelled, late-cancelled or
 * no-show booking must NOT block a new booking for the same staff member.
 */
export const BLOCKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.ATTENDED,
];

/** Fields the business side may change on a booking it owns. */
export const CHECKOUT_FIELDS = ["amountPaid", "tip", "paymentMethod"] as const;

export default BookingModel;
