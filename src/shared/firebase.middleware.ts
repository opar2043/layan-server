import { NextFunction, Request, Response } from "express";
import { ApiError } from "./apiError";

export const FIREBASE_UID_HEADER = "x-firebase-uid";

/**
 * Customer guard.
 *
 * Customers authenticate in the FRONTEND with Firebase (Google, Apple, email, ...).
 * The frontend verifies the Firebase ID token and forwards the resulting uid to
 * this server in the `x-firebase-uid` header; we read it and attach it to
 * `req.firebaseUid`. No password is ever accepted or issued for a customer, and
 * this server never signs a customer JWT.
 *
 * PRODUCTION TODO: replace this header trust with real server-side verification
 * using the `firebase-admin` SDK:
 *
 *     import { getAuth } from "firebase-admin/auth";
 *     const decoded = await getAuth().verifyIdToken(req.headers.authorization!);
 *     req.firebaseUid = decoded.uid;
 *
 * As written, anyone who can reach this server can forge the header. That is
 * acceptable for local development against demo data, and MUST be fixed before
 * any real launch.
 */
export function requireFirebaseUser(req: Request, _res: Response, next: NextFunction): void {
  const uid = req.headers[FIREBASE_UID_HEADER];

  if (typeof uid !== "string" || uid.trim().length === 0) {
    next(
      ApiError.unauthorized(
        `Missing ${FIREBASE_UID_HEADER} header. Customers must be authenticated via Firebase.`
      )
    );
    return;
  }

  req.firebaseUid = uid.trim();
  next();
}

export default requireFirebaseUser;
