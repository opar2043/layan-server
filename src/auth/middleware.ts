import type { NextFunction, Request, RequestHandler, Response } from "express";
import { verifyToken } from "./jwt";
import { ApiError } from "../shared/errors";
import { getCollection } from "../shared/db";
import type { StaffPermissions, UserDoc } from "../types/domain";
import { UserRole, PERMISSION_FLAGS, type UserRole as UserRoleType } from "../types/enums";
import { Collections } from "../shared/collections";

export interface AuthContext {
  id: string;
  role: UserRoleType;
  email?: string;
}

export interface BusinessAccess {
  businessId: string;
  /** How the caller reached this business — drives serializers and audit wording. */
  via: "admin" | "owner" | "staff";
  staffId: string | null;
  staffRole: string | null;
  permissions: StaffPermissions;
  /** The owner/admin has no `Staff` row; staff are limited to their own calendar. */
  selfOnly: boolean;
}

export interface RequestContext {
  user: AuthContext;
  access?: BusinessAccess;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: RequestContext;
      /** Alias kept for readability in controllers: `req.user.id`, `req.user.role`. */
      user?: AuthContext;
      staffPermissions?: StaffPermissions;
      businessAccess?: BusinessAccess;
    }
  }
}

const ALL_TRUE: StaffPermissions = {
  viewFinancials: true,
  viewCustomerData: true,
  manageCalendar: true,
  manageStaff: true,
  manageInventory: true,
  processRefunds: true,
};

const ALL_FALSE: StaffPermissions = {
  viewFinancials: false,
  viewCustomerData: false,
  manageCalendar: false,
  manageStaff: false,
  manageInventory: false,
  processRefunds: false,
};

export const FULL_PERMISSIONS: Readonly<StaffPermissions> = ALL_TRUE;
export const NO_PERMISSIONS: Readonly<StaffPermissions> = ALL_FALSE;

/** Normalises whatever is stored on a `Staff` doc into a complete flag set. */
export function normalisePermissions(raw: unknown): StaffPermissions {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as StaffPermissions;
  for (const flag of PERMISSION_FLAGS) {
    out[flag] = source[flag] === true;
  }
  return out;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/**
 * `requireAuth` — verifies the JWT, loads the live user record and attaches
 * `req.user = { id, role }`. Role comes from the database, not the token, so a
 * demotion takes effect immediately instead of at token expiry.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const token = extractToken(req);
      if (!token) throw ApiError.unauthorized();

      const payload = verifyToken(token);
      const user = await getCollection<UserDoc>(Collections.users).findOne({ _id: payload.sub });
      if (!user) throw ApiError.unauthorized("Account no longer exists");
      if (user.status === "deleted") throw ApiError.forbidden("Account deleted");
      if (user.status === "suspended" || user.status === "restricted") {
        throw ApiError.forbidden(`Account is ${user.status}. Contact Layan support.`);
      }

      const context: AuthContext = {
        id: user._id,
        role: user.role,
        ...(typeof user.email === "string" ? { email: user.email } : {}),
      };
      req.auth = { user: context };
      req.user = context;
      next();
    } catch (error) {
      next(error instanceof ApiError ? error : ApiError.unauthorized());
    }
  })();
};

/** `requireRole(...roles)` — 403 unless the authenticated role is in the list. */
export function requireRole(...roles: UserRoleType[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user;
    if (!user) return next(ApiError.unauthorized());
    if (!roles.includes(user.role)) {
      return next(
        ApiError.forbidden(`This action requires role: ${roles.join(" or ")}`, {
          yourRole: user.role,
        }),
      );
    }
    return next();
  };
}

/** `requireOwnResource` — the customer may only reach their own records. */
export const requireOwnResource: RequestHandler = (req, _res, next) => {
  const user = req.auth?.user;
  if (!user) return next(ApiError.unauthorized());
  if (user.role !== UserRole.CUSTOMER) {
    return next(
      ApiError.forbidden("This route is customer-only; use /api/business for staff and owners", {
        yourRole: user.role,
      }),
    );
  }
  return next();
};

/**
 * A `requireBusinessAccess(":businessId")` argument is a *reference*, not an id.
 * The actual value is read from the route's own params at request time, so the
 * access check can never be pointed at a hard-coded business.
 */
function resolveBusinessRef(req: Request, reference: string): string {
  if (!reference.startsWith(":")) return reference;
  const key = reference.slice(1);
  const body = req.body;
  const fromBody =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  const value = req.params[key] ?? req.query[key] ?? fromBody;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw ApiError.badRequest(`${key} is required`);
  }
  return value.trim();
}

/**
 * `requireBusinessAccess(businessId)` — passes for an admin, the owning user, or
 * an active `Staff` row on that business. Attaches `req.staffPermissions` so
 * controllers never need a second query for fine-grained flags.
 */
export function requireBusinessAccess(businessReference: string): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const user = req.auth?.user;
        if (!user) throw ApiError.unauthorized();

        const businessId = resolveBusinessRef(req, businessReference);
        const business = await getCollection(Collections.businesses).findOne({ _id: businessId });
        if (!business) throw ApiError.notFound("Business not found");

        if (user.role === UserRole.ADMIN) {
          attach(req, {
            businessId,
            via: "admin",
            staffId: null,
            staffRole: null,
            permissions: { ...ALL_TRUE },
            selfOnly: false,
          });
          return next();
        }

        if (typeof business.ownerId === "string" && business.ownerId === user.id) {
          attach(req, {
            businessId,
            via: "owner",
            staffId: null,
            staffRole: "owner",
            permissions: { ...ALL_TRUE },
            selfOnly: false,
          });
          return next();
        }

        if (user.role === UserRole.STAFF) {
          const staffDoc = await getCollection(Collections.staff).findOne({ userId: user.id });
          if (!staffDoc || staffDoc.businessId !== businessId) {
            throw ApiError.forbidden("You are not a member of this business");
          }
          if (staffDoc.status !== "active") {
            throw ApiError.forbidden(`Your staff account is ${staffDoc.status}`);
          }
          const permissions = normalisePermissions(staffDoc.permissions);
          attach(req, {
            businessId,
            via: "staff",
            staffId: staffDoc._id,
            staffRole: typeof staffDoc.role === "string" ? staffDoc.role : "stylist",
            permissions,
            // A stylist manages their own calendar only, regardless of flags.
            selfOnly: staffDoc.role === "stylist",
          });
          return next();
        }

        throw ApiError.forbidden("You do not have access to this business");
      } catch (error) {
        next(error instanceof ApiError ? error : ApiError.internal());
      }
    })();
  };
}

function attach(req: Request, access: BusinessAccess): void {
  const auth = req.auth ?? { user: req.user as AuthContext };
  auth.access = access;
  req.auth = auth;
  req.businessAccess = access;
  req.staffPermissions = access.permissions;
}

/** `requirePermission(flag)` — checked after `requireBusinessAccess`. */
export function requirePermission(flag: keyof StaffPermissions): RequestHandler {
  return (req, _res, next) => {
    const access = req.businessAccess;
    if (!access) return next(ApiError.forbidden("Business access has not been established"));

    if (access.via !== "staff") return next();

    if (access.permissions[flag] !== true) {
      return next(
        ApiError.forbidden(`Your staff role does not include the "${flag}" permission`, {
          required: flag,
          staffRole: access.staffRole,
        }),
      );
    }

    // Stylists hold `manageCalendar` for their own calendar only.
    if (access.selfOnly && flag === "manageCalendar") {
      const requested = req.query.staffId ?? req.params.staffId ?? req.body?.staffId;
      if (typeof requested === "string" && requested.length > 0 && requested !== access.staffId) {
        return next(
          ApiError.forbidden("A stylist can only manage their own calendar", {
            yourStaffId: access.staffId,
          }),
        );
      }
    }

    return next();
  };
}

/**
 * `manageStaff` is stricter than a plain permission flag: only the owner or a
 * `manager` staff row may create/edit staff. A stylist can never reach it.
 */
export const requireStaffManagement: RequestHandler = (req, _res, next) => {
  const access = req.businessAccess;
  if (!access) return next(ApiError.forbidden("Business access has not been established"));
  if (access.via !== "staff") return next();
  if (access.staffRole === "manager" || access.staffRole === "owner") return next();
  return next(
    ApiError.forbidden("Only a business owner or a manager can manage staff", {
      staffRole: access.staffRole,
    }),
  );
};

/** Editing a `Staff` row's permission flags is owner/admin only, never self-editable. */
export const requireOwnerOnly: RequestHandler = (req, _res, next) => {
  const access = req.businessAccess;
  if (!access) return next(ApiError.forbidden("Business access has not been established"));
  if (access.via === "staff" && access.staffRole !== "owner") {
    return next(
      ApiError.forbidden("Only the business owner can change this", { staffRole: access.staffRole }),
    );
  }
  return next();
};

export function currentUserId(req: Request): string {
  const id = req.auth?.user.id;
  if (!id) throw ApiError.unauthorized();
  return id;
}

export function currentUser(req: Request): AuthContext {
  const user = req.auth?.user;
  if (!user) throw ApiError.unauthorized();
  return user;
}

export type { NextFunction, Response };
