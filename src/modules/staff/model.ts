import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { StaffPermissionLevel } from "../../types/enums";

/** One working day for a staff member, e.g. { day: "monday", start: "09:00", end: "17:00" }. */
export interface WorkingHour {
  day: string;
  start: string;
  end: string;
}

/** An approved absence, used to suppress bookings for that window. */
export interface TimeOffEntry {
  start: Date;
  end: Date;
  reason?: string;
}

/**
 * A staff member's credentials live HERE (owners' live on Business, admins' on Admin).
 * A staff member always belongs to exactly one business.
 */
export interface IStaff extends Document {
  businessId: Document["_id"];
  name: string;
  email: string;
  passwordHash: string;
  permissionLevel: StaffPermissionLevel;
  servicesOffered: Document["_id"][];
  workingHours: WorkingHour[];
  timeOff: TimeOffEntry[];
  /** Percentage of service revenue owed to the staff member, 0-100. */
  commissionRate?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const StaffModel = () => getCollection<IStaff>(COLLECTIONS.STAFF);

/**
 * Split of edit rights between an owner and a staff member, per the spec:
 *   - owner  -> permissions, assigned services, commission, hours, active flag
 *   - staff  -> their OWN workingHours and timeOff only (enforced via req.auth.id)
 */
export const OWNER_EDITABLE_STAFF_FIELDS = [
  "name",
  "email",
  "permissionLevel",
  "servicesOffered",
  "commissionRate",
  "isActive",
  "workingHours",
  "timeOff",
] as const;

export const SELF_EDITABLE_STAFF_FIELDS = ["workingHours", "timeOff"] as const;

export default StaffModel;
