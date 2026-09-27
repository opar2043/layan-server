import { Response } from "express";
import { ObjectId } from "mongodb";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { comparePassword, hashPassword } from "../../shared/password";
import { signToken } from "../../shared/jwt";
import { serialize, timestamps } from "../../shared/helpers";
import { COLLECTIONS, getCollection } from "../../shared/db";
import {
  optionalString,
  requireEmail,
  requirePassword,
  requireString,
} from "../../shared/validate";
import { Role, VerificationStatus } from "../../types/enums";
import { JwtPayload } from "../../types";
import { AdminModel, IAdmin } from "./model";
import { IBusiness } from "../businesses/model";
import { IStaff } from "../staff/model";

/**
 * POST /api/auth/register/owner
 *
 * Public self-service signup. Creates the owner AND their business in one step,
 * since an owner account is inseparable from the business it runs. The business
 * starts unverified — an admin must approve it via PATCH /api/businesses/:id/verify
 * before it appears in public discovery.
 */
export async function registerOwner(body: Record<string, unknown>, res: Response) {
  const ownerName = requireString(body, "ownerName", { min: 2, max: 120 });
  const email = requireEmail(body);
  const password = requirePassword(body, "password", 8);
  const businessName = requireString(body, "businessName", { min: 2, max: 120 });
  const category = requireString(body, "category", { min: 2, max: 60 });
  const address = requireString(body, "address", { min: 3, max: 300 });
  const city = requireString(body, "city", { min: 2, max: 120 });
  const description = optionalString(body, "description", { max: 2000 });

  const businesses = getCollection<IBusiness>(COLLECTIONS.BUSINESSES);
  const existing = await businesses.findOne({ email });
  if (existing) {
    throw ApiError.conflict("A business is already registered with that email address");
  }

  const now = new Date();
  const document = {
    ownerName,
    email,
    passwordHash: await hashPassword(password),
    businessName,
    category,
    description,
    location: { address, city, mobileServiceRadiusKm: 0 },
    portfolio: [] as string[],
    amenities: [] as string[],
    instantBookEnabled: false,
    verificationStatus: VerificationStatus.PENDING,
    isBusinessVerified: false,
    isIdentityVerified: false,
    badges: [] as string[],
    masterAccountId: null,
    businessScore: 0,
    createdAt: now,
    updatedAt: now,
  };

  const result = await businesses.insertOne(document);
  const businessId = result.insertedId.toHexString();

  const token = signToken({ id: businessId, role: Role.OWNER, businessId, email });

  // Re-read so the response carries the driver's own _id, and rely on serialize()
  // to drop passwordHash.
  const created = await businesses.findOne({ _id: result.insertedId });

  return sendSuccess(res, 201, "Business owner registered successfully", {
    token,
    role: Role.OWNER,
    business: serialize(created),
  });
}

/**
 * POST /api/auth/login
 *
 * One entry point for all three credentialed roles. The caller states which role
 * it wants, and we look in that role's collection — this is what lets an owner and
 * a staff member share an email domain without colliding.
 *
 * Customers are rejected here on purpose: they sign in with Firebase and never
 * receive a token from this server.
 */
export async function login(body: Record<string, unknown>, res: Response) {
  const email = requireEmail(body);
  const password = requireString(body, "password");
  const role = requireString(body, "role");

  if (role === Role.CUSTOMER) {
    throw ApiError.badRequest(
      "Customers do not sign in with a password. Authenticate with Firebase and send the x-firebase-uid header."
    );
  }
  if (![Role.OWNER, Role.STAFF, Role.ADMIN].includes(role as Role)) {
    throw ApiError.badRequest('"role" must be one of: owner, staff, admin');
  }

  const account = await findAccountByEmail(email, role as Role);

  if (!account) {
    throw ApiError.unauthorized("Invalid email or password");
  }
  if (!account.passwordHash) {
    throw ApiError.unauthorized("Invalid email or password");
  }

  const passwordMatches = await comparePassword(password, account.passwordHash);
  if (!passwordMatches) {
    throw ApiError.unauthorized("Invalid email or password");
  }

  const id = account.id;
  const token =
    role === Role.ADMIN
      ? signToken({ id, role: Role.ADMIN, email })
      : signToken({
          id,
          role: role as Role.OWNER | Role.STAFF,
          businessId: account.businessId,
          email,
        });

  return sendSuccess(res, 200, "Login successful", {
    token,
    role,
    businessId: account.businessId ?? null,
  });
}

/** GET /api/auth/me — returns whichever profile the token belongs to. */
export async function me(auth: JwtPayload, res: Response) {
  if (auth.role === Role.ADMIN) {
    const admin = await AdminModel().findOne({ _id: new ObjectId(auth.id) });
    if (!admin) throw ApiError.notFound("Admin account no longer exists");
    return sendSuccess(res, 200, "Admin profile retrieved", { role: Role.ADMIN, profile: serialize(admin as IAdmin) });
  }

  if (auth.role === Role.STAFF) {
    const staff = await getCollection<IStaff>(COLLECTIONS.STAFF).findOne({ _id: new ObjectId(auth.id) });
    if (!staff) throw ApiError.notFound("Staff account no longer exists");
    return sendSuccess(res, 200, "Staff profile retrieved", {
      role: Role.STAFF,
      businessId: auth.businessId ?? null,
      profile: serialize(staff),
    });
  }

  const business = await getCollection<IBusiness>(COLLECTIONS.BUSINESSES).findOne({
    _id: new ObjectId(auth.id),
  });
  if (!business) throw ApiError.notFound("Business account no longer exists");
  return sendSuccess(res, 200, "Business profile retrieved", {
    role: Role.OWNER,
    profile: serialize(business),
  });
}

interface FoundAccount {
  id: string;
  passwordHash?: string;
  businessId?: string;
}

async function findAccountByEmail(email: string, role: Role): Promise<FoundAccount | null> {
  if (role === Role.ADMIN) {
    const admin = await AdminModel().findOne({ email });
    return admin
      ? { id: (admin as IAdmin)._id.toHexString(), passwordHash: (admin as IAdmin).passwordHash }
      : null;
  }

  if (role === Role.STAFF) {
    const staff = await getCollection<IStaff>(COLLECTIONS.STAFF).findOne({ email });
    if (!staff) return null;
    return {
      id: (staff as IStaff)._id.toHexString(),
      passwordHash: (staff as IStaff).passwordHash,
      businessId: (staff as IStaff).businessId.toHexString(),
    };
  }

  const business = await getCollection<IBusiness>(COLLECTIONS.BUSINESSES).findOne({ email });
  if (!business) return null;
  return {
    id: (business as IBusiness)._id.toHexString(),
    passwordHash: (business as IBusiness).passwordHash,
    businessId: (business as IBusiness)._id.toHexString(),
  };
}
