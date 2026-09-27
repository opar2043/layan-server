import { Filter, Sort } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import {
  getPagination,
  queryFlag,
  sendPaginated,
  serialize,
  serializeMany,
} from "../../shared/helpers";
import { toObjectId } from "../../shared/validate";
import { Role, VerificationStatus } from "../../types/enums";
import { JwtPayload } from "../../types";
import { BusinessLocation, BusinessModel, IBusiness, OWNER_EDITABLE_FIELDS } from "./model";
import { getActiveServices } from "../services/services";
import { StaffModel } from "../staff/model";

/**
 * Public roster of a business's bookable staff.
 *
 * `GET /api/staff` is owner-only, so without this a signed-out visitor has no way
 * to see who they can book with. Only the fields a customer needs to make a
 * choice are returned — `passwordHash`, `timeOff` and `commissionRate` are
 * projected out. Inactive staff are excluded, since they cannot take bookings.
 *
 * The projection is exclusion-only: MongoDB rejects a mixed include/exclude
 * projection, so every other field (workingHours, servicesOffered) stays in.
 */
async function getPublicStaff(businessId: string): Promise<Record<string, unknown>[]> {
  const docs = await StaffModel()
    .find(
      { businessId: toObjectId(businessId, "business id"), isActive: true },
      { projection: { passwordHash: 0, timeOff: 0, commissionRate: 0 } }
    )
    .sort({ name: 1 })
    .toArray();
  return serializeMany(docs);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * GET /api/businesses — public discovery.
 *
 * Only verified businesses are returned unless an admin explicitly asks otherwise
 * (pending businesses are invisible to the public by design, so a brand-new signup
 * never appears in search).
 */
export async function listBusinesses(
  query: Record<string, unknown>,
  res: Response,
  auth?: JwtPayload
) {
  const pagination = getPagination(query);
  const businesses = BusinessModel();
  const filter: Filter<IBusiness> = {};

  // Admins can opt out of the verified-only default to inspect everything.
  if (auth?.role !== Role.ADMIN) {
    filter.isBusinessVerified = true;
  } else if (query.all === undefined) {
    filter.isBusinessVerified = true;
  }

  if (typeof query.category === "string" && query.category) {
    filter.category = query.category;
  }
  if (typeof query.city === "string" && query.city) {
    filter["location.city"] = new RegExp(`^${escapeRegex(query.city)}$`, "i");
  }

  const instantBook = queryFlag(query.instantBook);
  if (instantBook !== undefined) {
    filter.instantBookEnabled = instantBook;
  }

  if (typeof query.q === "string" && query.q.trim()) {
    const regex = new RegExp(escapeRegex(query.q.trim()), "i");
    filter.$or = [
      { businessName: regex },
      { category: regex },
      { "location.city": regex },
    ];
  }

  const sortOption: Sort =
    query.sort === "score" ? { businessScore: -1 } : { createdAt: -1 };

  const [docs, total] = await Promise.all([
    businesses
      .find(filter, { projection: { passwordHash: 0 } })
      .sort(sortOption)
      .skip(pagination.skip)
      .limit(pagination.limit)
      .toArray(),
    businesses.countDocuments(filter),
  ]);

  return sendPaginated(
    res,
    "Businesses retrieved",
    serializeMany(docs),
    total,
    pagination
  );
}

/** GET /api/businesses/me — the signed-in owner's own business. */
export async function getMyBusiness(auth: JwtPayload, res: Response) {
  const business = await BusinessModel().findOne({ _id: toObjectId(auth.id) });
  if (!business) throw ApiError.notFound("Business not found");
  return sendSuccess(res, 200, "Business retrieved", { business: serialize(business) });
}

/** PATCH /api/businesses/me — restricted to the owner-editable whitelist. */
export async function updateMyBusiness(
  auth: JwtPayload,
  body: Record<string, unknown>,
  res: Response
) {
  const businesses = BusinessModel();
  const business = await businesses.findOne({ _id: toObjectId(auth.id) });
  if (!business) throw ApiError.notFound("Business not found");

  const update: Record<string, unknown> = { updatedAt: new Date() };

  const stringFields = [
    "ownerName",
    "businessName",
    "category",
    "description",
    "openingHours",
    "coverImage",
    "profileImage",
    "cancellationPolicy",
    "bookingUrl",
  ] as const;

  for (const field of stringFields) {
    if (body[field] !== undefined) {
      if (body[field] === null) {
        update[field] = null;
      } else if (typeof body[field] !== "string") {
        throw ApiError.badRequest(`"${field}" must be a string`);
      } else {
        update[field] = (body[field] as string).trim();
      }
    }
  }

  if (body.portfolio !== undefined) {
    update.portfolio = body.portfolio === null ? [] : toStringArray(body.portfolio, "portfolio");
  }
  if (body.amenities !== undefined) {
    update.amenities = body.amenities === null ? [] : toStringArray(body.amenities, "amenities");
  }
  if (body.instantBookEnabled !== undefined) {
    if (typeof body.instantBookEnabled !== "boolean") {
      throw ApiError.badRequest('"instantBookEnabled" must be a boolean');
    }
    update.instantBookEnabled = body.instantBookEnabled;
  }
  if (body.location !== undefined) {
    update.location = mergeLocation(business.location, body.location);
  }

  await businesses.updateOne({ _id: business._id }, { $set: update });
  const updated = await businesses.findOne({ _id: business._id });
  return sendSuccess(res, 200, "Business updated", { business: serialize(updated) });
}

/** GET /api/businesses/pending — admin review queue. */
export async function listPendingBusinesses(res: Response) {
  const businesses = BusinessModel();
  const docs = await businesses
    .find({ verificationStatus: VerificationStatus.PENDING }, { projection: { passwordHash: 0 } })
    .sort({ createdAt: 1 })
    .toArray();

  return sendSuccess(res, 200, "Pending businesses retrieved", {
    businesses: serializeMany(docs),
    total: docs.length,
  });
}

/**
 * PATCH /api/businesses/:id/verify — admin decision.
 * The three flags are always written together so they can never disagree:
 * approved -> both verified, rejected -> both false, pending -> back to review.
 */
export async function verifyBusiness(
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const businesses = BusinessModel();
  const businessId = toObjectId(params.id, "business id");
  const business = await businesses.findOne({ _id: businessId });
  if (!business) throw ApiError.notFound("Business not found");

  const status = body.status as VerificationStatus;
  if (!status || !Object.values(VerificationStatus).includes(status)) {
    throw ApiError.badRequest('"status" must be one of: pending, approved, rejected', {
      allowed: Object.values(VerificationStatus),
    });
  }

  const isApproved = status === VerificationStatus.APPROVED;

  await businesses.updateOne(
    { _id: business._id },
    {
      $set: {
        verificationStatus: status,
        isBusinessVerified: isApproved,
        isIdentityVerified: isApproved,
        updatedAt: new Date(),
      },
    }
  );

  const updated = await businesses.findOne({ _id: business._id });
  return sendSuccess(res, 200, `Business verification set to "${status}"`, {
    business: serialize(updated),
  });
}

/** GET /api/businesses/:id — public single profile, with its live services. */
export async function getBusinessById(params: Record<string, string>, res: Response) {
  const businessId = toObjectId(params.id, "business id");
  const businesses = BusinessModel();
  const business = await businesses.findOne(
    { _id: businessId },
    { projection: { passwordHash: 0 } }
  );
  if (!business) throw ApiError.notFound("Business not found");

  const services = await getActiveServices(business._id.toHexString());
  const staff = await getPublicStaff(business._id.toHexString());

  return sendSuccess(res, 200, "Business retrieved", {
    business: serialize(business, { services, staff }),
  });
}

function toStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw ApiError.badRequest(`"${field}" must be an array of strings`);
  }
  return value as string[];
}

function mergeLocation(current: BusinessLocation, incoming: unknown): BusinessLocation {
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    throw ApiError.badRequest('"location" must be an object');
  }
  const source = incoming as Record<string, unknown>;
  const merged: BusinessLocation = { ...current };

  if (source.address !== undefined) {
    if (typeof source.address !== "string" || !source.address.trim()) {
      throw ApiError.badRequest('"location.address" must be a non-empty string');
    }
    merged.address = source.address.trim();
  }
  if (source.city !== undefined) {
    if (typeof source.city !== "string" || !source.city.trim()) {
      throw ApiError.badRequest('"location.city" must be a non-empty string');
    }
    merged.city = source.city.trim();
  }
  for (const key of ["latitude", "longitude", "mobileServiceRadiusKm"] as const) {
    if (source[key] === undefined) continue;
    const numeric = Number(source[key]);
    if (Number.isNaN(numeric)) {
      throw ApiError.badRequest(`"location.${key}" must be a number`);
    }
    // Latitude/longitude are legitimately negative outside the eastern hemisphere,
    // so only the radius is bounded at zero. Lat/lng are bounded by the globe.
    if (key === "mobileServiceRadiusKm" && numeric < 0) {
      throw ApiError.badRequest('"location.mobileServiceRadiusKm" must be greater than or equal to 0');
    }
    if (key === "latitude" && (numeric < -90 || numeric > 90)) {
      throw ApiError.badRequest('"location.latitude" must be between -90 and 90');
    }
    if (key === "longitude" && (numeric < -180 || numeric > 180)) {
      throw ApiError.badRequest('"location.longitude" must be between -180 and 180');
    }
    merged[key] = numeric;
  }

  return merged;
}

export { OWNER_EDITABLE_FIELDS };
export default {
  listBusinesses,
  getMyBusiness,
  updateMyBusiness,
  listPendingBusinesses,
  verifyBusiness,
  getBusinessById,
};
