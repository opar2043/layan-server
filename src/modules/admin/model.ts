import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { DisputeStatus } from "../../types/enums";

/**
 * A complaint raised against a booking, by either the customer or the business.
 * Both sides may attach evidence; an admin settles it and records the outcome.
 */
export interface IDispute extends Document {
  bookingId: Document["_id"];
  customerId: Document["_id"];
  businessId: Document["_id"];
  reason: string;
  customerEvidence?: string;
  businessEvidence?: string;
  status: DisputeStatus;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const DisputeModel = () => getCollection<IDispute>(COLLECTIONS.DISPUTES);

export const DISPUTE_EDITABLE_FIELDS = [
  "reason",
  "customerEvidence",
  "businessEvidence",
] as const;

export default DisputeModel;
