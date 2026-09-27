import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { WaitlistStatus } from "../../types/enums";

/**
 * A customer waiting for a slot at a business. `preferredDates` holds every datetime
 * the customer could attend, so a business can offer the first one that frees up.
 */
export interface IWaitlistEntry extends Document {
  customerId: Document["_id"];
  businessId: Document["_id"];
  serviceId: Document["_id"];
  preferredStaffId?: Document["_id"];
  preferredDates: Date[];
  status: WaitlistStatus;
  /** Set when the entry is offered a discounted last-minute slot. */
  isInstantSlotDiscount: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const WaitlistModel = () => getCollection<IWaitlistEntry>(COLLECTIONS.WAITLIST_ENTRIES);

export default WaitlistModel;
