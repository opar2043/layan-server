import { Filter, ObjectId, UpdateFilter } from "mongodb";
import { Response } from "express";
import { COLLECTIONS, getCollection } from "../../shared/db";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated, serialize, serializeMany } from "../../shared/helpers";
import {
  optionalId,
  optionalString,
  optionalStringArray,
  requireEmail,
  requireEnum,
  requireString,
} from "../../shared/validate";
import { GenderPreference } from "../../types/enums";
import { IUser, UserModel, UserLocation } from "./model";

/** Alphabet excludes look-alike characters so referral codes are readable over the phone. */
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function generateReferralCode(): Promise<string> {
  const users = UserModel();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let code = "LAY";
    for (let i = 0; i < 5; i += 1) {
      code += REFERRAL_ALPHABET[Math.floor(Math.random() * REFERRAL_ALPHABET.length)];
    }
    const clash = await users.findOne({ referralCode: code }, { projection: { _id: 1 } });
    if (!clash) return code;
  }
  throw ApiError.internal("Could not allocate a unique referral code");
}

/**
 * Resolves a Firebase uid to a customer `_id`. This is the callback shared routes
 * (bookings, waitlist, reviews, wallet, messages) hand to resolveActor().
 */
export async function findCustomerIdByFirebaseUid(firebaseUid: string): Promise<string | null> {
  const user = await UserModel().findOne(
    { firebaseUid },
    { projection: { _id: 1 } }
  );
  return user ? (user as IUser)._id.toHexString() : null;
}

async function requireCustomer(firebaseUid: string | undefined): Promise<IUser> {
  if (!firebaseUid) throw ApiError.unauthorized();
  const user = await UserModel().findOne({ firebaseUid });
  if (!user) {
    throw ApiError.notFound("No customer profile found — call POST /api/users/sync first");
  }
  return user as IUser;
}

function parseLocation(
  raw: unknown
): UserLocation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.badRequest('"location" must be an object with city / latitude / longitude');
  }
  const source = raw as Record<string, unknown>;
  const city = requireString(source, "city", { min: 2, max: 120 });
  const latitude = source.latitude === undefined ? undefined : Number(source.latitude);
  const longitude = source.longitude === undefined ? undefined : Number(source.longitude);
  if (latitude !== undefined && Number.isNaN(latitude)) {
    throw ApiError.badRequest('"location.latitude" must be a number');
  }
  if (longitude !== undefined && Number.isNaN(longitude)) {
    throw ApiError.badRequest('"location.longitude" must be a number');
  }
  return {
    city,
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
  };
}

/**
 * POST /api/users/sync
 *
 * Called by the frontend right after Firebase login. Idempotent: the first call
 * creates the profile, every later call returns the existing one untouched, so a
 * customer cannot rewrite their identity by replaying this endpoint.
 */
export async function syncCustomer(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  if (!firebaseUid) throw ApiError.unauthorized();

  const users = UserModel();
  const existing = (await users.findOne({ firebaseUid })) as IUser | null;
  if (existing) {
    return sendSuccess(res, 200, "Customer profile retrieved", { user: serialize(existing) });
  }

  const name = requireString(body, "name", { min: 2, max: 120 });
  const email = requireEmail(body);
  const phone = optionalString(body, "phone", { max: 32 });
  const referredBy = optionalString(body, "referredBy", { max: 32 });
  const location = parseLocation(body.location);
  const genderPreference =
    body.genderPreference === undefined || body.genderPreference === null
      ? undefined
      : requireEnum(body, "genderPreference", GenderPreference);

  const now = new Date();
  const document = {
    firebaseUid,
    name,
    email,
    phone,
    genderPreference,
    location,
    favouriteCategories: [] as string[],
    favouriteBusinessIds: [] as ObjectId[],
    referralCode: await generateReferralCode(),
    referredBy: referredBy ?? null,
    createdAt: now,
    updatedAt: now,
  };

  let result;
  try {
    result = await users.insertOne(document);
  } catch {
    // Lost a race on the unique email index between two concurrent syncs.
    throw ApiError.conflict("A customer profile with that email already exists");
  }

  const created = (await users.findOne({ _id: result.insertedId })) as IUser;
  return sendSuccess(res, 201, "Customer profile created", { user: serialize(created) });
}

/** GET /api/users/me */
export async function getMe(firebaseUid: string | undefined, res: Response) {
  const user = await requireCustomer(firebaseUid);
  return sendSuccess(res, 200, "Customer profile retrieved", { user: serialize(user) });
}

/** PATCH /api/users/me — profile basics, location and favourite categories. */
export async function updateMe(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const user = await requireCustomer(firebaseUid);
  const users = UserModel();

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (body.name !== undefined) update.name = requireString(body, "name", { min: 2, max: 120 });
  if (body.email !== undefined) update.email = requireEmail(body);
  if (body.phone !== undefined) update.phone = optionalString(body, "phone", { max: 32 });
  if (body.genderPreference !== undefined) {
    update.genderPreference =
      body.genderPreference === null
        ? null
        : requireEnum(body, "genderPreference", GenderPreference);
  }
  if (body.favouriteCategories !== undefined) {
    update.favouriteCategories =
      body.favouriteCategories === null
        ? []
        : optionalStringArray(body, "favouriteCategories") ?? [];
  }
  if (body.location !== undefined) {
    update.location = body.location === null ? null : parseLocation(body.location) ?? null;
  }

  await users.updateOne({ _id: user._id }, { $set: update });
  const updated = (await users.findOne({ _id: user._id })) as IUser;
  return sendSuccess(res, 200, "Customer profile updated", { user: serialize(updated) });
}

/**
 * PATCH /api/users/me/favourites
 *
 * Body `{ businessId, action: "add" | "remove" }`. Uses $addToSet / $pull so the
 * operation is idempotent — favouriting twice is not an error, and unfavouriting
 * something that was never favourited is a no-op rather than a 404.
 */
export async function updateFavourites(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const user = await requireCustomer(firebaseUid);
  const users = UserModel();

  const businessId = optionalId(body, "businessId");
  if (!businessId) {
    throw ApiError.badRequest('"businessId" is required');
  }

  const action = requireString(body, "action");
  if (action !== "add" && action !== "remove") {
    throw ApiError.badRequest('"action" must be either "add" or "remove"');
  }

  // The driver's $pull typing expects a Condition, but the runtime form for
  // "remove this exact member" is the bare value — so the operand is cast.
  const update: UpdateFilter<IUser> =
    action === "add"
      ? { $addToSet: { favouriteBusinessIds: businessId } }
      : { $pull: { favouriteBusinessIds: businessId } as unknown as Filter<IUser> };

  await users.updateOne({ _id: user._id }, update);

  const updated = (await users.findOne({ _id: user._id })) as IUser;
  return sendSuccess(
    res,
    200,
    `Business ${action === "add" ? "added to" : "removed from"} favourites`,
    { user: serialize(updated) }
  );
}

/** GET /api/users — admin-only paginated customer list. */
export async function listCustomers(
  query: Record<string, unknown>,
  res: Response
) {
  const pagination = getPagination(query);
  const users = UserModel();

  const filter: Filter<IUser> = {};
  if (typeof query.city === "string" && query.city) {
    filter["location.city"] = query.city;
  }
  if (typeof query.q === "string" && query.q.trim()) {
    const safe = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(safe, "i");
    filter.$or = [{ name: regex }, { email: regex }];
  }

  const [docs, total] = await Promise.all([
    users.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).toArray(),
    users.countDocuments(filter),
  ]);

  return sendPaginated(
    res,
    "Customers retrieved",
    serializeMany(docs),
    total,
    pagination
  );
}

export { requireCustomer };
export default {
  syncCustomer,
  getMe,
  updateMe,
  updateFavourites,
  listCustomers,
  findCustomerIdByFirebaseUid,
};
