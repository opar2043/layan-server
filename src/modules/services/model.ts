import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";

/** A bookable offering belonging to exactly one business. */
export interface IService extends Document {
  businessId: Document["_id"];
  name: string;
  description?: string;
  category: string;
  durationMinutes: number;
  price: number;
  /** Gap after the service, so the business can reset between appointments. */
  bufferMinutes: number;
  /** How far ahead a customer must book. */
  leadTimeHours: number;
  /** Free-cancellation cutoff before the appointment. */
  cancellationWindowHours: number;
  isInstantBook: boolean;
  requiresConsultationForm: boolean;
  /** Soft-delete flag — services are never removed, only deactivated. */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const ServiceModel = () => getCollection<IService>(COLLECTIONS.SERVICES);

/** Everything an owner may edit on their own service. */
export const SERVICE_EDITABLE_FIELDS = [
  "name",
  "description",
  "category",
  "durationMinutes",
  "price",
  "bufferMinutes",
  "leadTimeHours",
  "cancellationWindowHours",
  "isInstantBook",
  "requiresConsultationForm",
  "isActive",
] as const;

export default ServiceModel;
