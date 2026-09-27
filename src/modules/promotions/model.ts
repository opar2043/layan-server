import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { PromotionCreatedBy, PromotionType } from "../../types/enums";

/**
 * A discount. When `businessId` is null the promotion is platform-wide and is shown
 * to every customer; otherwise it belongs to a single business.
 */
export interface IPromotion extends Document {
  businessId?: Document["_id"];
  title: string;
  type: PromotionType;
  discountPercent?: number;
  discountAmount?: number;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  createdBy: PromotionCreatedBy;
  createdAt: Date;
  updatedAt: Date;
}

export const PromotionModel = () => getCollection<IPromotion>(COLLECTIONS.PROMOTIONS);

export const PROMOTION_EDITABLE_FIELDS = [
  "title",
  "type",
  "discountPercent",
  "discountAmount",
  "startDate",
  "endDate",
  "isActive",
] as const;

export default PromotionModel;
