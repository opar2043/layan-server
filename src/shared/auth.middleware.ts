import { NextFunction, Request, Response } from "express";
import { extractBearerToken, verifyToken } from "./jwt";
import { ApiError } from "./apiError";
import { Role } from "../types/enums";

/**
 * JWT guard for Owner / Staff / Admin routes.
 * Customers are NEVER authenticated here — they use requireFirebaseUser.
 * Attaches the decoded payload to `req.auth`.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    next(ApiError.unauthorized("Missing Authorization: Bearer <token> header"));
    return;
  }

  try {
    req.auth = verifyToken(token);
    next();
  } catch {
    next(ApiError.unauthorized("Invalid or expired token"));
  }
}

/**
 * Attaches `req.auth` when a valid token is present, but never rejects.
 *
 * Used on endpoints that are public yet behave differently for a signed-in
 * owner/staff/admin — for example GET /api/services, which falls back to the
 * caller's own business instead of requiring ?businessId=. A malformed token is
 * treated as "not signed in" rather than an error, because the route works
 * fine anonymously.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    next();
    return;
  }
  try {
    req.auth = verifyToken(token);
  } catch {
    // Ignored on purpose — see the doc comment above.
  }
  next();
}

/**
 * Role gate, applied after requireAuth. Rejects with 403 (not 401) so callers can
 * tell "you are not logged in" apart from "you are logged in but not allowed".
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(ApiError.unauthorized());
      return;
    }
    if (!roles.includes(req.auth.role)) {
      next(
        ApiError.forbidden(
          `This action requires one of the following roles: ${roles.join(", ")}`
        )
      );
      return;
    }
    next();
  };
}

export default { requireAuth, optionalAuth, requireRole };
