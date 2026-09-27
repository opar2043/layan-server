import { Filter, ObjectId } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated } from "../../shared/helpers";
import { populateMany } from "../../shared/populate";
import { COLLECTIONS, getCollection } from "../../shared/db";
import {
  optionalBoolean,
  optionalId,
  optionalEnum,
  requireId,
  toObjectId,
} from "../../shared/validate";
import { WaitlistStatus } from "../../types/enums";
import { JwtPayload } from "../../types";
import { ActorContext, resolveActor } from "../../shared/identify.middleware";
import { IBusiness } from "../businesses/model";
import { IService } from "../services/model";
import { IWaitlistEntry, WaitlistModel } from "./model";
import { findCustomerIdByFirebaseUid } from "../users/users";

const WAITLIST_POPULATE = [
  { field: "customerId", collection: COLLECTIONS.USERS, select: ["name", "email", "phone"] },
  { field: "businessId", collection: COLLECTIONS.BUSINESSES, select: ["businessName", "category"] },
  { field: "serviceId", collection: COLLECTIONS.SERVICES, select: ["name", "price", "durationMinutes"] },
  { field: "preferredStaffId", collection: COLLECTIONS.STAFF, select: ["name"] },
];

function businessIdFromAuth(auth: JwtPayload): string {
  const id = auth.businessId ?? auth.id;
  if (!id) throw ApiError.forbidden("Token does not carry a business scope");
  return id;
}

function parsePreferredDates(value: unknown): Date[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('"preferredDates" must be a non-empty array of dates');
  }
  return value.map((entry, index) => {
    const date = new Date(String(entry));
    if (Number.isNaN(date.getTime())) {
      throw ApiError.badRequest(`"preferredDates[${index}]" is not a valid date`);
    }
    return date;
  });
}

/** POST /api/waitlist — customer joins the queue for a service at a business. */
export async function createWaitlistEntry(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const actor = await resolveActor({ firebaseUid }, findCustomerIdByFirebaseUid);
  if (!actor.customerId) {
    throw ApiError.forbidden("Only customers can join a waitlist");
  }

  const serviceId = requireId(body, "serviceId");
  const preferredStaffId = optionalId(body, "preferredStaffId");
  const preferredDates = parsePreferredDates(body.preferredDates);
  const isInstantSlotDiscount = optionalBoolean(body, "isInstantSlotDiscount") ?? false;

  // The business is derived from the service, so the two cannot disagree.
  const service = await getCollection<IService>(COLLECTIONS.SERVICES).findOne({ _id: serviceId });
  if (!service) throw ApiError.notFound("Service not found");
  if (!service.isActive) throw ApiError.badRequest("That service is no longer available");

  const now = new Date();
  const document = {
    customerId: new ObjectId(actor.customerId),
    businessId: service.businessId,
    serviceId,
    preferredStaffId,
    preferredDates,
    status: WaitlistStatus.WAITING,
    isInstantSlotDiscount,
    createdAt: now,
    updatedAt: now,
  };

  const result = await WaitlistModel().insertOne(document);
  const created = await WaitlistModel().findOne({ _id: result.insertedId });
  const [item] = await populateMany(created ? [created] : [], WAITLIST_POPULATE);

  return sendSuccess(res, 201, "Added to waitlist", { waitlistEntry: item });
}

/** DELETE /api/waitlist/:id — the customer withdraws their own entry. */
export async function deleteWaitlistEntry(
  firebaseUid: string | undefined,
  params: Record<string, string>,
  res: Response
) {
  const actor = await resolveActor({ firebaseUid }, findCustomerIdByFirebaseUid);
  if (!actor.customerId) {
    throw ApiError.forbidden("Only customers can leave a waitlist");
  }

  const entries = WaitlistModel();
  const entry = await entries.findOne({ _id: toObjectId(params.id, "waitlist id") });
  if (!entry) throw ApiError.notFound("Waitlist entry not found");

  if ((entry as IWaitlistEntry).customerId.toHexString() !== actor.customerId) {
    throw ApiError.forbidden("You can only remove your own waitlist entries");
  }

  await entries.deleteOne({ _id: (entry as IWaitlistEntry)._id });
  return sendSuccess(res, 200, "Removed from waitlist", {
    waitlistEntryId: (entry as IWaitlistEntry)._id.toHexString(),
  });
}

/** GET /api/waitlist — owner only, scoped to their own business. */
export async function listWaitlist(
  auth: JwtPayload,
  query: Record<string, unknown>,
  res: Response
) {
  const pagination = getPagination(query);
  const entries = WaitlistModel();

  const filter: Filter<IWaitlistEntry> = {
    businessId: toObjectId(businessIdFromAuth(auth), "business id"),
  };

  if (typeof query.status === "string" && query.status) {
    if (!Object.values(WaitlistStatus).includes(query.status as WaitlistStatus)) {
      throw ApiError.badRequest('"status" filter is not a valid waitlist status', {
        allowed: Object.values(WaitlistStatus),
      });
    }
    filter.status = query.status as WaitlistStatus;
  }

  const [docs, total] = await Promise.all([
    entries.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).toArray(),
    entries.countDocuments(filter),
  ]);

  return sendPaginated(
    res,
    "Waitlist retrieved",
    await populateMany(docs, WAITLIST_POPULATE),
    total,
    pagination
  );
}

/** PATCH /api/waitlist/:id — owner advances the entry through its lifecycle. */
export async function updateWaitlistEntry(
  auth: JwtPayload,
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const status = optionalEnum(body, "status", WaitlistStatus);
  if (!status) {
    throw ApiError.badRequest('"status" is required', { allowed: Object.values(WaitlistStatus) });
  }

  const entries = WaitlistModel();
  const entry = await entries.findOne({ _id: toObjectId(params.id, "waitlist id") });
  if (!entry) throw ApiError.notFound("Waitlist entry not found");

  if ((entry as IWaitlistEntry).businessId.toHexString() !== businessIdFromAuth(auth)) {
    throw ApiError.forbidden("That waitlist entry belongs to another business");
  }

  await entries.updateOne(
    { _id: (entry as IWaitlistEntry)._id },
    { $set: { status, updatedAt: new Date() } }
  );

  const updated = await entries.findOne({ _id: (entry as IWaitlistEntry)._id });
  const [item] = await populateMany(updated ? [updated] : [], WAITLIST_POPULATE);

  return sendSuccess(res, 200, `Waitlist entry set to "${status}"`, { waitlistEntry: item });
}

export { IBusiness };
export default {
  createWaitlistEntry,
  deleteWaitlistEntry,
  listWaitlist,
  updateWaitlistEntry,
};
