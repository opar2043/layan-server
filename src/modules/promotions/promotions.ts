import { Filter } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { serialize, serializeMany } from "../../shared/helpers";
import {
  optionalDate,
  optionalEnum,
  optionalNumber,
  optionalString,
  requireDate,
  requireEnum,
  requireString,
  toObjectId,
  toObjectIdOrNull,
} from "../../shared/validate";
import { PromotionCreatedBy, PromotionType, Role } from "../../types/enums";
import { JwtPayload } from "../../types";
import { IPromotion, PromotionModel } from "./model";

/**
 * POST /api/promotions
 *
 * An owner's promotion is pinned to their own business; an admin's is created with
 * no `businessId`, which makes it platform-wide. The scope is derived from the
 * token, never from the body, so neither role can write a promotion into someone
 * else's business.
 */
export async function createPromotion(
  auth: JwtPayload,
  body: Record<string, unknown>,
  res: Response
) {
  const title = requireString(body, "title", { min: 3, max: 200 });
  const type = requireEnum(body, "type", PromotionType);
  const startDate = requireDate(body, "startDate");
  const endDate = requireDate(body, "endDate");
  const discountPercent = optionalNumber(body, "discountPercent", { min: 1, max: 100 });
  const discountAmount = optionalNumber(body, "discountAmount", { min: 0 });

  if (endDate <= startDate) {
    throw ApiError.badRequest('"endDate" must be after "startDate"');
  }
  if (discountPercent === undefined && discountAmount === undefined) {
    throw ApiError.badRequest(
      'A promotion needs either "discountPercent" or "discountAmount"'
    );
  }

  const isAdmin = auth.role === Role.ADMIN;
  const businessId = isAdmin
    ? null
    : toObjectId(auth.businessId ?? auth.id, "business id");

  const now = new Date();
  const document = {
    businessId,
    title,
    type,
    discountPercent,
    discountAmount,
    startDate,
    endDate,
    isActive: true,
    createdBy: isAdmin ? PromotionCreatedBy.ADMIN : PromotionCreatedBy.OWNER,
    createdAt: now,
    updatedAt: now,
  };

  const result = await PromotionModel().insertOne(document);
  const created = await PromotionModel().findOne({ _id: result.insertedId });
  return sendSuccess(res, 201, "Promotion created", { promotion: serialize(created) });
}

/**
 * GET /api/promotions?businessId=
 *
 * Only promotions whose window contains "now" are returned. With a businessId the
 * result includes that business's own promotions PLUS every platform-wide one;
 * without it, only platform-wide promotions come back.
 */
export async function listPromotions(query: Record<string, unknown>, res: Response) {
  const now = new Date();

  const filter: Filter<IPromotion> = {
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  };

  if (typeof query.businessId === "string" && query.businessId) {
    const businessId = toObjectId(query.businessId, "business id");
    filter.$or = [{ businessId }, { businessId: null }];
  } else {
    filter.businessId = null;
  }

  const docs = await PromotionModel().find(filter).sort({ createdAt: -1 }).toArray();
  return sendSuccess(res, 200, "Promotions retrieved", {
    promotions: serializeMany(docs),
    total: docs.length,
  });
}

/**
 * PATCH /api/promotions/:id
 * Ownership rule: an owner may only touch promotions carrying their own businessId,
 * an admin may only touch platform-wide promotions. Neither can edit the other's.
 */
export async function updatePromotion(
  auth: JwtPayload,
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const promotions = PromotionModel();
  const promotion = await promotions.findOne({ _id: toObjectId(params.id, "promotion id") });
  if (!promotion) throw ApiError.notFound("Promotion not found");

  assertCanModify(auth, promotion as IPromotion);

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (body.title !== undefined) {
    update.title = requireString(body, "title", { min: 3, max: 200 });
  }
  if (body.type !== undefined) {
    update.type = requireEnum(body, "type", PromotionType);
  }
  if (body.discountPercent !== undefined) {
    update.discountPercent =
      body.discountPercent === null
        ? null
        : optionalNumber(body, "discountPercent", { min: 1, max: 100 }) ?? null;
  }
  if (body.discountAmount !== undefined) {
    update.discountAmount =
      body.discountAmount === null
        ? null
        : optionalNumber(body, "discountAmount", { min: 0 }) ?? null;
  }
  if (body.startDate !== undefined) update.startDate = requireDate(body, "startDate");
  if (body.endDate !== undefined) update.endDate = requireDate(body, "endDate");
  if (body.isActive !== undefined) update.isActive = Boolean(body.isActive);

  const mergedStart = (update.startDate as Date | undefined) ?? (promotion as IPromotion).startDate;
  const mergedEnd = (update.endDate as Date | undefined) ?? (promotion as IPromotion).endDate;
  if (mergedEnd <= mergedStart) {
    throw ApiError.badRequest('"endDate" must be after "startDate"');
  }

  await promotions.updateOne({ _id: (promotion as IPromotion)._id }, { $set: update });
  const updated = await promotions.findOne({ _id: (promotion as IPromotion)._id });
  return sendSuccess(res, 200, "Promotion updated", { promotion: serialize(updated) });
}

/** DELETE /api/promotions/:id — soft-deactivates rather than removing. */
export async function deactivatePromotion(
  auth: JwtPayload,
  params: Record<string, string>,
  res: Response
) {
  const promotions = PromotionModel();
  const promotion = await promotions.findOne({ _id: toObjectId(params.id, "promotion id") });
  if (!promotion) throw ApiError.notFound("Promotion not found");

  assertCanModify(auth, promotion as IPromotion);

  await promotions.updateOne(
    { _id: (promotion as IPromotion)._id },
    { $set: { isActive: false, updatedAt: new Date() } }
  );

  const updated = await promotions.findOne({ _id: (promotion as IPromotion)._id });
  return sendSuccess(res, 200, "Promotion deactivated", { promotion: serialize(updated) });
}

function assertCanModify(auth: JwtPayload, promotion: IPromotion): void {
  const isPlatformWide = !promotion.businessId;

  if (auth.role === Role.ADMIN) {
    if (!isPlatformWide) {
      throw ApiError.forbidden("Admins can only modify platform-wide promotions");
    }
    return;
  }

  if (auth.role !== Role.OWNER) {
    throw ApiError.forbidden("Only owners and admins can modify promotions");
  }
  if (isPlatformWide) {
    throw ApiError.forbidden("Platform-wide promotions can only be modified by an admin");
  }
  if (promotion.businessId?.toHexString() !== (auth.businessId ?? auth.id)) {
    throw ApiError.forbidden("That promotion belongs to another business");
  }
}

export default { createPromotion, listPromotions, updatePromotion, deactivatePromotion };
