import { Filter } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated, serialize, serializeMany } from "../../shared/helpers";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireNumber,
  requireString,
  toObjectId,
} from "../../shared/validate";
import { Role } from "../../types/enums";
import { JwtPayload } from "../../types";
import { IService, ServiceModel } from "./model";

/** The business an owner/staff token acts for. */
function businessIdFromAuth(auth: JwtPayload): string {
  const id = auth.businessId ?? auth.id;
  if (!id) throw ApiError.forbidden("Token does not carry a business scope");
  return id;
}

async function requireOwnedService(serviceId: string, auth: JwtPayload): Promise<IService> {
  const service = await ServiceModel().findOne({ _id: toObjectId(serviceId, "service id") });
  if (!service) throw ApiError.notFound("Service not found");

  if (
    (service as IService).businessId.toHexString() !== businessIdFromAuth(auth) ||
    auth.role !== Role.OWNER
  ) {
    throw ApiError.forbidden("You can only manage services belonging to your own business");
  }
  return service as IService;
}

/** Internal helper: active services for a business. Also used by the public business profile. */
export async function getActiveServices(businessId: string): Promise<Record<string, unknown>[]> {
  const docs = await ServiceModel()
    .find({ businessId: toObjectId(businessId, "business id"), isActive: true })
    .sort({ price: 1 })
    .toArray();
  return serializeMany(docs);
}

/** POST /api/services — owner creates a service on their own business. */
export async function createService(
  auth: JwtPayload,
  body: Record<string, unknown>,
  res: Response
) {
  const businessId = toObjectId(businessIdFromAuth(auth), "business id");

  const name = requireString(body, "name", { min: 2, max: 150 });
  const category = requireString(body, "category", { min: 2, max: 60 });
  const durationMinutes = requireNumber(body, "durationMinutes", {
    min: 5,
    max: 600,
    integer: true,
  });
  const price = requireNumber(body, "price", { min: 0 });
  const description = optionalString(body, "description", { max: 2000 });

  const now = new Date();
  const document = {
    businessId,
    name,
    description,
    category,
    durationMinutes,
    price,
    bufferMinutes: optionalNumber(body, "bufferMinutes", { min: 0, max: 240, integer: true }) ?? 0,
    leadTimeHours: optionalNumber(body, "leadTimeHours", { min: 0, max: 720, integer: true }) ?? 0,
    cancellationWindowHours:
      optionalNumber(body, "cancellationWindowHours", { min: 0, max: 720, integer: true }) ?? 0,
    isInstantBook: optionalBoolean(body, "isInstantBook") ?? true,
    requiresConsultationForm: optionalBoolean(body, "requiresConsultationForm") ?? false,
    isActive: optionalBoolean(body, "isActive") ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await ServiceModel().insertOne(document);
  const created = await ServiceModel().findOne({ _id: result.insertedId });
  return sendSuccess(res, 201, "Service created", { service: serialize(created) });
}

/**
 * GET /api/services?businessId= — public.
 * An owner or staff member calling without a query param implicitly gets their own
 * business, so the owner/staff app can list services with no extra round trip.
 */
export async function listServices(
  query: Record<string, unknown>,
  res: Response,
  auth?: JwtPayload
) {
  const pagination = getPagination(query);

  let businessId: string;
  let includeInactive = false;

  if (typeof query.businessId === "string" && query.businessId) {
    businessId = query.businessId;
    // Owners keep seeing services they have deactivated, but only their own.
    includeInactive = auth?.role === Role.OWNER && businessId === businessIdFromAuth(auth);
  } else if (auth && (auth.role === Role.OWNER || auth.role === Role.STAFF)) {
    businessId = businessIdFromAuth(auth);
    includeInactive = auth.role === Role.OWNER;
  } else {
    throw ApiError.badRequest('"businessId" query parameter is required');
  }

  const filter: Filter<IService> = { businessId: toObjectId(businessId, "business id") };
  if (!includeInactive) {
    filter.isActive = true;
  }

  const [docs, total] = await Promise.all([
    ServiceModel()
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .toArray(),
    ServiceModel().countDocuments(filter),
  ]);

  return sendPaginated(res, "Services retrieved", serializeMany(docs), total, pagination);
}

/** GET /api/services/:id — public. */
export async function getService(params: Record<string, string>, res: Response) {
  const service = await ServiceModel().findOne({ _id: toObjectId(params.id, "service id") });
  if (!service) throw ApiError.notFound("Service not found");
  if (!(service as IService).isActive) {
    throw ApiError.notFound("Service is no longer available");
  }
  return sendSuccess(res, 200, "Service retrieved", { service: serialize(service) });
}

/** PATCH /api/services/:id — owner of the service only. */
export async function updateService(
  auth: JwtPayload,
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const service = await requireOwnedService(params.id, auth);

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    update.name = requireString(body, "name", { min: 2, max: 150 });
  }
  if (body.category !== undefined) {
    update.category = requireString(body, "category", { min: 2, max: 60 });
  }
  if (body.description !== undefined) {
    update.description =
      body.description === null
        ? null
        : optionalString(body, "description", { max: 2000 }) ?? null;
  }
  if (body.durationMinutes !== undefined) {
    update.durationMinutes = requireNumber(body, "durationMinutes", {
      min: 5,
      max: 600,
      integer: true,
    });
  }
  if (body.price !== undefined) {
    update.price = requireNumber(body, "price", { min: 0 });
  }
  if (body.bufferMinutes !== undefined) {
    update.bufferMinutes = requireNumber(body, "bufferMinutes", { min: 0, max: 240, integer: true });
  }
  if (body.leadTimeHours !== undefined) {
    update.leadTimeHours = requireNumber(body, "leadTimeHours", { min: 0, max: 720, integer: true });
  }
  if (body.cancellationWindowHours !== undefined) {
    update.cancellationWindowHours = requireNumber(body, "cancellationWindowHours", {
      min: 0,
      max: 720,
      integer: true,
    });
  }
  if (body.isInstantBook !== undefined) {
    update.isInstantBook = Boolean(body.isInstantBook);
  }
  if (body.requiresConsultationForm !== undefined) {
    update.requiresConsultationForm = Boolean(body.requiresConsultationForm);
  }
  if (body.isActive !== undefined) {
    update.isActive = Boolean(body.isActive);
  }

  await ServiceModel().updateOne({ _id: service._id }, { $set: update });
  const updated = await ServiceModel().findOne({ _id: service._id });
  return sendSuccess(res, 200, "Service updated", { service: serialize(updated) });
}

/** DELETE /api/services/:id — soft delete. Bookings keep their history. */
export async function deleteService(
  auth: JwtPayload,
  params: Record<string, string>,
  res: Response
) {
  const service = await requireOwnedService(params.id, auth);

  await ServiceModel().updateOne(
    { _id: service._id },
    { $set: { isActive: false, updatedAt: new Date() } }
  );

  const updated = await ServiceModel().findOne({ _id: service._id });
  return sendSuccess(res, 200, "Service deactivated", { service: serialize(updated) });
}

export default {
  createService,
  listServices,
  getService,
  updateService,
  deleteService,
  getActiveServices,
};
