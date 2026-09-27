import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { hashPassword } from "../../shared/password";
import { getPagination, sendPaginated, serialize, serializeMany } from "../../shared/helpers";
import { populateMany } from "../../shared/populate";
import {
  optionalNumber,
  optionalString,
  requireEmail,
  requireEnum,
  requirePassword,
  requireString,
  toObjectId,
} from "../../shared/validate";
import { Role, StaffPermissionLevel } from "../../types/enums";
import { JwtPayload } from "../../types";
import { COLLECTIONS } from "../../shared/db";
import {
  OWNER_EDITABLE_STAFF_FIELDS,
  SELF_EDITABLE_STAFF_FIELDS,
  TimeOffEntry,
  WorkingHour,
  IStaff,
  StaffModel,
} from "./model";

/** The owner-only subset: everything in the owner's set that staff may not touch. */
const OWNER_ONLY_FIELDS = OWNER_EDITABLE_STAFF_FIELDS.filter(
  (field) => !SELF_EDITABLE_STAFF_FIELDS.includes(field as never)
) as readonly string[];

function businessIdFromAuth(auth: JwtPayload): string {
  const id = auth.businessId ?? auth.id;
  if (!id) throw ApiError.forbidden("Token does not carry a business scope");
  return id;
}

function parseWorkingHours(value: unknown): WorkingHour[] {
  if (!Array.isArray(value)) {
    throw ApiError.badRequest('"workingHours" must be an array of { day, start, end } objects');
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw ApiError.badRequest(`"workingHours[${index}]" must be an object`);
    }
    const source = entry as Record<string, unknown>;
    return {
      day: requireString(source, "day", { max: 20 }),
      start: requireString(source, "start", { max: 5 }),
      end: requireString(source, "end", { max: 5 }),
    };
  });
}

function parseTimeOff(value: unknown): TimeOffEntry[] {
  if (!Array.isArray(value)) {
    throw ApiError.badRequest('"timeOff" must be an array of { start, end, reason? } objects');
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw ApiError.badRequest(`"timeOff[${index}]" must be an object`);
    }
    const source = entry as Record<string, unknown>;
    const start = new Date(String(source.start));
    const end = new Date(String(source.end));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw ApiError.badRequest(`"timeOff[${index}]" requires valid start and end dates`);
    }
    if (end <= start) {
      throw ApiError.badRequest(`"timeOff[${index}].end" must be after start`);
    }
    return {
      start,
      end,
      ...(source.reason !== undefined && source.reason !== null
        ? { reason: String(source.reason) }
        : {}),
    };
  });
}

function parseServiceIds(value: unknown): ReturnType<typeof toObjectId>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw ApiError.badRequest('"servicesOffered" must be an array of service ids');
  }
  return value.map((id) => toObjectId(id, "servicesOffered[]"));
}

/** POST /api/staff — owner invites a staff member with a temporary password. */
export async function createStaff(
  auth: JwtPayload,
  body: Record<string, unknown>,
  res: Response
) {
  const businessId = toObjectId(businessIdFromAuth(auth), "business id");

  const name = requireString(body, "name", { min: 2, max: 120 });
  const email = requireEmail(body);
  const password = requirePassword(body, "password", 8);

  const existing = await StaffModel().findOne({ email }, { projection: { _id: 1 } });
  if (existing) {
    throw ApiError.conflict("A staff account with that email already exists");
  }

  const now = new Date();
  const document = {
    businessId,
    name,
    email,
    passwordHash: await hashPassword(password),
    permissionLevel:
      body.permissionLevel === undefined
        ? StaffPermissionLevel.STANDARD
        : requireEnum(body, "permissionLevel", StaffPermissionLevel),
    servicesOffered:
      body.servicesOffered === undefined ? [] : parseServiceIds(body.servicesOffered),
    workingHours: body.workingHours === undefined ? [] : parseWorkingHours(body.workingHours),
    timeOff: body.timeOff === undefined ? [] : parseTimeOff(body.timeOff),
    commissionRate: optionalNumber(body, "commissionRate", { min: 0, max: 100 }),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await StaffModel().insertOne(document);
  const created = await StaffModel().findOne({ _id: result.insertedId });
  // serialize() strips passwordHash, so the temporary password never round-trips.
  const [item] = await populateMany(created ? [created] : [], [
    { field: "servicesOffered", collection: COLLECTIONS.SERVICES, select: ["name", "price", "durationMinutes"] },
  ]);
  return sendSuccess(res, 201, "Staff member created", { staff: item });
}

/** GET /api/staff — owner only, always scoped to their own business. */
export async function listStaff(
  auth: JwtPayload,
  query: Record<string, unknown>,
  res: Response
) {
  const pagination = getPagination(query);
  const businessId = toObjectId(businessIdFromAuth(auth), "business id");

  const [docs, total] = await Promise.all([
    StaffModel().find({ businessId }).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).toArray(),
    StaffModel().countDocuments({ businessId }),
  ]);

  const items = await populateMany(docs, [
    { field: "servicesOffered", collection: COLLECTIONS.SERVICES, select: ["name", "price", "durationMinutes"] },
  ]);

  return sendPaginated(res, "Staff retrieved", items, total, pagination);
}

/** GET /api/staff/:id — visible to the owner of the business, or the staff member themselves. */
export async function getStaff(
  auth: JwtPayload,
  params: Record<string, string>,
  res: Response
) {
  const staff = await StaffModel().findOne({ _id: toObjectId(params.id, "staff id") });
  if (!staff) throw ApiError.notFound("Staff member not found");

  const isSelf = staff._id.toHexString() === auth.id;
  const isOwnerOfBusiness =
    auth.role === Role.OWNER &&
    (staff as IStaff).businessId.toHexString() === businessIdFromAuth(auth);

  if (!isSelf && !isOwnerOfBusiness) {
    throw ApiError.forbidden("You can only view staff belonging to your own business");
  }

  const [item] = await populateMany([staff], [
    { field: "servicesOffered", collection: COLLECTIONS.SERVICES, select: ["name", "price", "durationMinutes"] },
  ]);

  return sendSuccess(res, 200, "Staff member retrieved", { staff: item });
}

/**
 * PATCH /api/staff/:id
 *
 * Two different permission sets, per the spec:
 *   - an OWNER may edit permissions, assigned services, commission, hours and the
 *     active flag for anyone in their business;
 *   - a STAFF member may edit ONLY their own workingHours and timeOff.
 * Admin is not a participant here — staff records belong to the business.
 */
export async function updateStaff(
  auth: JwtPayload,
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const staff = await StaffModel().findOne({ _id: toObjectId(params.id, "staff id") });
  if (!staff) throw ApiError.notFound("Staff member not found");

  const isOwner = auth.role === Role.OWNER;
  const isSelf = staff._id.toHexString() === auth.id;

  if (!isOwner && !isSelf) {
    throw ApiError.forbidden("You can only edit your own profile or staff in your own business");
  }
  if (
    isOwner &&
    (staff as IStaff).businessId.toHexString() !== businessIdFromAuth(auth)
  ) {
    throw ApiError.forbidden("That staff member belongs to another business");
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };

  // A staff member may only ever change hours and time off. Owner-only fields are
  // rejected outright rather than silently dropped, so the caller never gets a
  // success response for an edit that did not happen.
  if (!isOwner) {
    const attempted = OWNER_ONLY_FIELDS.filter((field) => body[field] !== undefined);
    if (attempted.length > 0) {
      throw ApiError.forbidden(
        `Only a business owner can change: ${attempted.join(", ")}. ` +
          `You may edit: ${SELF_EDITABLE_STAFF_FIELDS.join(", ")}.`
      );
    }
  }

  // Fields reserved for the owner.
  if (isOwner) {
    if (body.name !== undefined) {
      update.name = requireString(body, "name", { min: 2, max: 120 });
    }
    if (body.email !== undefined) {
      update.email = requireEmail(body);
    }
    if (body.permissionLevel !== undefined) {
      update.permissionLevel = requireEnum(body, "permissionLevel", StaffPermissionLevel);
    }
    if (body.servicesOffered !== undefined) {
      update.servicesOffered = parseServiceIds(body.servicesOffered);
    }
    if (body.commissionRate !== undefined) {
      update.commissionRate =
        body.commissionRate === null
          ? null
          : optionalNumber(body, "commissionRate", { min: 0, max: 100 }) ?? null;
    }
    if (body.isActive !== undefined) {
      update.isActive = Boolean(body.isActive);
    }
  }

  // Hours are editable by both the owner and the staff member themselves.
  if (body.workingHours !== undefined) {
    update.workingHours = parseWorkingHours(body.workingHours);
  }
  if (body.timeOff !== undefined) {
    update.timeOff = parseTimeOff(body.timeOff);
  }

  await StaffModel().updateOne({ _id: staff._id }, { $set: update });
  const updated = await StaffModel().findOne({ _id: staff._id });

  const [item] = await populateMany(updated ? [updated] : [], [
    { field: "servicesOffered", collection: COLLECTIONS.SERVICES, select: ["name", "price", "durationMinutes"] },
  ]);

  return sendSuccess(res, 200, "Staff member updated", { staff: item });
}

/** DELETE /api/staff/:id — owner only, soft delete so past bookings stay intact. */
export async function deleteStaff(
  auth: JwtPayload,
  params: Record<string, string>,
  res: Response
) {
  const staff = await StaffModel().findOne({ _id: toObjectId(params.id, "staff id") });
  if (!staff) throw ApiError.notFound("Staff member not found");

  if (
    auth.role !== Role.OWNER ||
    (staff as IStaff).businessId.toHexString() !== businessIdFromAuth(auth)
  ) {
    throw ApiError.forbidden("Only the business owner can remove a staff member");
  }

  await StaffModel().updateOne(
    { _id: staff._id },
    { $set: { isActive: false, updatedAt: new Date() } }
  );

  const updated = await StaffModel().findOne({ _id: staff._id });
  return sendSuccess(res, 200, "Staff member deactivated", { staff: serialize(updated) });
}

export default { createStaff, listStaff, getStaff, updateStaff, deleteStaff };
