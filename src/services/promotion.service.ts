import { Collections } from "../shared/collections";
import { asUpdate, getCollection } from "../shared/db";
import { generateId, isoNow } from "../shared/utils";
import type { PromotionDoc } from "../types/domain";

export function applyDiscount(
  amountMinor: number,
  discount: { type: string; value: number },
): number {
  if (!discount || discount.value <= 0) return 0;
  if (discount.type === "percentage") {
    return Math.min(amountMinor, Math.round((amountMinor * discount.value) / 100));
  }
  return Math.min(amountMinor, Math.round(discount.value));
}

export async function findActivePromotion(
  businessId: string,
  promotionId: string,
): Promise<PromotionDoc | null> {
  const now = Date.now();
  const promotion = await getCollection<PromotionDoc>(Collections.promotions).findOne({
    _id: promotionId,
    $or: [{ businessId }, { businessId: null }],
  });
  if (!promotion) return null;
  if (promotion.status !== "active") return null;
  if (typeof promotion.validFrom === "string" && new Date(promotion.validFrom).getTime() > now) {
    return null;
  }
  if (typeof promotion.validTo === "string" && new Date(promotion.validTo).getTime() < now) {
    return null;
  }
  const max = promotion.maxRedemptions;
  if (typeof max === "number" && (promotion.redemptionCount ?? 0) >= max) return null;
  return promotion;
}

export async function findActiveLastMinutePromotion(
  businessId: string,
  promotionId: string,
): Promise<PromotionDoc | null> {
  const promotion = await findActivePromotion(businessId, promotionId);
  if (!promotion) return null;
  if (promotion.type !== "last_minute") return null;
  return promotion;
}

/** The business's active last-minute promotion, if it has one. */
export async function findBusinessLastMinutePromotion(
  businessId: string,
): Promise<PromotionDoc | null> {
  const now = Date.now();
  const candidates = await getCollection<PromotionDoc>(Collections.promotions)
    .find({ businessId, type: "last_minute", status: "active" })
    .toArray();
  return (
    candidates.find((promotion) => {
      if (new Date(promotion.validFrom).getTime() > now) return false;
      if (promotion.validTo && new Date(promotion.validTo).getTime() < now) return false;
      if (promotion.maxRedemptions !== null && promotion.redemptionCount >= promotion.maxRedemptions) {
        return false;
      }
      return true;
    }) ?? null
  );
}

export async function incrementRedemption(promotionId: string): Promise<void> {
  await getCollection<PromotionDoc>(Collections.promotions).updateOne(
    { _id: promotionId },
    asUpdate<PromotionDoc>({ $inc: { redemptionCount: 1 }, $set: { updatedAt: isoNow() } }),
  );
}

export async function createPromotion(
  input: Omit<PromotionDoc, "_id" | "redemptionCount" | "createdAt" | "updatedAt">,
): Promise<PromotionDoc> {
  const at = isoNow();
  const doc: PromotionDoc = {
    ...input,
    _id: generateId("prm"),
    redemptionCount: 0,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<PromotionDoc>(Collections.promotions).insertOne(doc);
  return doc;
}
