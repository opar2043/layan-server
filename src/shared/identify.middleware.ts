import { NextFunction, Request, Response } from "express";
import { extractBearerToken, verifyToken } from "./jwt";
import { ApiError } from "./apiError";
import { FIREBASE_UID_HEADER } from "./firebase.middleware";
import { Role } from "../types/enums";
import { JwtPayload } from "../types";

/**
 * Guard for endpoints shared by more than one role (bookings, messages, disputes).
 * It accepts EITHER credential and attaches whichever is present, so the
 * controller can branch on the caller's identity:
 *
 *   customer -> `req.firebaseUid` is set
 *   owner/staff -> `req.auth` is set (`req.auth.businessId` is the business)
 *   admin -> `req.auth` is set with no `businessId`
 *
 * If a bearer token IS sent but is invalid we reject with 401 rather than silently
 * downgrading to a customer, otherwise a bad token would look like a valid Firebase
 * request.
 */
export function identifyAny(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req.headers.authorization);
  const uidHeader = req.headers[FIREBASE_UID_HEADER];
  const firebaseUid = typeof uidHeader === "string" && uidHeader.trim() ? uidHeader.trim() : null;

  if (token) {
    try {
      req.auth = verifyToken(token);
    } catch {
      next(ApiError.unauthorized("Invalid or expired token"));
      return;
    }
  }

  if (firebaseUid) {
    req.firebaseUid = firebaseUid;
  }

  if (!req.auth && !req.firebaseUid) {
    next(
      ApiError.unauthorized(
        "Provide either an Authorization: Bearer <token> header (owner/staff/admin) or an x-firebase-uid header (customer)"
      )
    );
    return;
  }

  next();
}

export interface ActorContext {
  isCustomer: boolean;
  isBusinessSide: boolean;
  isAdmin: boolean;
  role: Role;
  /** Mongo id of the acting customer, when known. */
  customerId?: string;
  /** Mongo id of the acting business, for owner/staff. */
  businessId?: string;
  /** Mongo id of the acting staff member, when the caller is staff. */
  staffId?: string;
}

/** Minimal shape resolveActor needs — structurally satisfied by an Express Request. */
export interface IdentityCarrier {
  firebaseUid?: string;
  auth?: JwtPayload;
}

/**
 * Collapses `req.firebaseUid` / `req.auth` into one object so shared controllers
 * (bookings, messages, disputes) do not repeat the branching logic.
 *
 * A customer is resolved by looking their `users` document up on `firebaseUid`.
 */
export async function resolveActor(
  req: IdentityCarrier,
  findUserByFirebaseUid: (uid: string) => Promise<string | null>
): Promise<ActorContext> {
  if (req.auth) {
    const { id, role, businessId } = req.auth;
    if (role === Role.ADMIN) {
      return { isCustomer: false, isBusinessSide: false, isAdmin: true, role };
    }
    if (role === Role.STAFF) {
      return {
        isCustomer: false,
        isBusinessSide: true,
        isAdmin: false,
        role,
        staffId: id,
        businessId,
      };
    }
    // Owner: the business IS the account, so owner id and business id are the same.
    return {
      isCustomer: false,
      isBusinessSide: true,
      isAdmin: false,
      role,
      businessId: businessId ?? id,
    };
  }

  const customerId = await findUserByFirebaseUid(req.firebaseUid as string);
  if (!customerId) {
    throw ApiError.notFound("No customer profile found — call POST /api/users/sync first");
  }

  return {
    isCustomer: true,
    isBusinessSide: false,
    isAdmin: false,
    role: Role.CUSTOMER,
    customerId,
  };
}

export default { identifyAny, resolveActor };
