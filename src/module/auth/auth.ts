import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { getCollection, asUpdate } from "../../shared/db";
import { signToken } from "../../auth/jwt";
import { hashPassword, verifyPassword } from "../../auth/password";
import { generateId, isoNow, optionalString, requireString } from "../../shared/utils";
import { config } from "../../shared/config";
import type { Paginated } from "../../shared/response";
import type { UserDoc } from "../../types/domain";
import { UserRole } from "../../types/enums";

/**
 * Authentication logic: registration, login, token refresh, profile and password
 * management.
 *
 * Two rules are enforced here rather than in the route layer:
 *  - `staff` and `admin` can never be self-assigned from a public request body.
 *  - Every issued token's role claim is re-read from the database, so a
 *    demotion or suspension takes effect on the next request rather than when
 *    the current token happens to expire.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/** A syntactically valid hash that can never match, used to keep login timing flat. */
const IMPOSSIBLE_HASH = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";

function users() {
  return getCollection<UserDoc>(Collections.users);
}

/** Normalises an email to lower case so `A@B.com` and `a@b.com` are one account. */
export function normaliseEmail(value: unknown): string {
  const email = requireString(value, "email").toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw ApiError.badRequest("email is not a valid address");
  return email;
}

export function assertPasswordStrength(value: unknown): string {
  const password = requireString(value, "password");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw ApiError.badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw ApiError.badRequest("password must contain both letters and numbers");
  }
  return password;
}

export interface AuthResult {
  token: string;
  user: UserDoc;
  expiresInSeconds: number;
}

/**
 * Customers and business owners self-register. Anything else is a privilege
 * escalation attempt and is rejected before the user row is even created.
 */
export async function register(body: Record<string, unknown>): Promise<AuthResult> {
  const requestedRole = body.role ?? UserRole.CUSTOMER;
  if (requestedRole !== UserRole.CUSTOMER && requestedRole !== UserRole.BUSINESS_OWNER) {
    throw ApiError.forbidden("Only customer and business_owner accounts can self-register", {
      requestedRole,
    });
  }

  const email = normaliseEmail(body.email);
  const password = assertPasswordStrength(body.password);

  if (await users().findOne({ email })) {
    throw ApiError.conflict("An account with that email already exists", { email });
  }

  const at = isoNow();
  const user: UserDoc = {
    _id: generateId("usr"),
    role: requestedRole as UserDoc["role"],
    email,
    phone: optionalString(body.phone) ?? null,
    passwordHash: await hashPassword(password),
    firstName: optionalString(body.firstName) ?? null,
    lastName: optionalString(body.lastName) ?? null,
    avatarUrl: optionalString(body.avatarUrl) ?? null,
    status: "active",
    emailVerified: false,
    phoneVerified: false,
    marketingConsent: { sms: false, email: false, push: false },
    deviceTokens: [],
    homeLocation: null,
    preferences: {},
    referralCode: generateId("ref").toUpperCase(),
    lastLoginAt: at,
    createdAt: at,
    updatedAt: at,
  };

  await users().insertOne(user);
  return {
    token: signToken({ sub: user._id, role: user.role, email: user.email }),
    user,
    expiresInSeconds: config.jwtExpiresInSeconds,
  };
}

/**
 * The same message for "no such user" and "wrong password", and a bcrypt
 * comparison against a dummy hash either way, so the endpoint cannot be used to
 * enumerate registered addresses.
 */
export async function login(body: Record<string, unknown>): Promise<AuthResult> {
  const email = normaliseEmail(body.email);
  const password = requireString(body.password, "password");

  const user = await users().findOne({ email });
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? IMPOSSIBLE_HASH);

  if (!user || !passwordMatches) {
    throw ApiError.unauthorized("Email or password is incorrect");
  }
  if (user.status === "deleted") throw ApiError.forbidden("Account deleted");
  if (user.status === "suspended" || user.status === "restricted") {
    throw ApiError.forbidden(`Account is ${user.status}. Contact Layan support.`);
  }

  await users().updateOne({ _id: user._id }, { $set: { lastLoginAt: isoNow() } });

  return {
    token: signToken({ sub: user._id, role: user.role, email: user.email }),
    user,
    expiresInSeconds: config.jwtExpiresInSeconds,
  };
}

/**
 * Mints a new access token. The role claim is re-read from the database rather
 * than copied from the presented token, so a demotion is reflected immediately.
 */
export async function refreshToken(userId: string): Promise<{ token: string; expiresInSeconds: number }> {
  const user = await users().findOne({ _id: userId });
  if (!user) throw ApiError.unauthorized("Account no longer exists");
  return {
    token: signToken({ sub: user._id, role: user.role, email: user.email }),
    expiresInSeconds: config.jwtExpiresInSeconds,
  };
}

export async function getUser(userId: string): Promise<UserDoc> {
  const user = await users().findOne({ _id: userId });
  if (!user) throw ApiError.notFound("User not found");
  return user;
}

/**
 * Profile edits. `role`, `status`, `passwordHash` and the verification flags are
 * server-owned: only the allow-listed fields below are read from the body.
 */
const EDITABLE_FIELDS = ["firstName", "lastName", "avatarUrl", "phone", "dateOfBirth", "gender"] as const;

export async function updateProfile(
  userId: string,
  body: Record<string, unknown>,
): Promise<UserDoc> {
  const set: Record<string, unknown> = { updatedAt: isoNow() };

  for (const field of EDITABLE_FIELDS) {
    if (body[field] !== undefined) {
      set[field] = body[field] === null ? null : optionalString(body[field]) ?? null;
    }
  }
  if (body.preferences !== undefined) set.preferences = body.preferences;
  if (body.marketingConsent !== undefined) {
    const consent = body.marketingConsent as Record<string, unknown>;
    set.marketingConsent = {
      sms: consent.sms === true,
      email: consent.email === true,
      push: consent.push === true,
    };
  }

  await users().updateOne({ _id: userId }, asUpdate<UserDoc>({ $set: set }));
  return getUser(userId);
}

/**
 * Requires the current password so a stolen token alone cannot lock the real
 * owner out of their account. Returns a fresh token because the old one may have
 * been captured.
 */
export async function changePassword(
  userId: string,
  currentPassword: unknown,
  newPassword: unknown,
): Promise<{ token: string }> {
  const current = requireString(currentPassword, "currentPassword");
  const next = assertPasswordStrength(newPassword);

  const user = await getUser(userId);
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw ApiError.unauthorized("Current password is incorrect");
  }

  await users().updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(next), updatedAt: isoNow() } },
  );
  return { token: signToken({ sub: user._id, role: user.role, email: user.email }) };
}

/**
 * Sessions are stateless JWTs, so there is no server-side session list to show.
 * This exists so the UI can render "last signed in" from `lastLoginAt` instead of
 * inventing devices that were never tracked.
 */
export async function listSessions(userId: string): Promise<Paginated<Record<string, unknown>>> {
  const user = await users().findOne({ _id: userId });
  return {
    data: [{ current: true, lastLoginAt: user?.lastLoginAt ?? null }],
    page: 1,
    pageSize: 1,
    total: 1,
    totalPages: 1,
  };
}
