import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "./jwt";
import { sendError } from "../shared/response";

export interface AuthUser {
  sub: string;
  email?: string;
  user_type?: string;
}

export type AuthRequest = Request & { user?: AuthUser };

export function protect(req: Request, res: Response, next: NextFunction): Response | void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) return sendError(res, 401, "Authentication token required");

  try {
    const payload = verifyToken(token);
    const user: AuthUser = { sub: payload.sub };
    if (payload.email !== undefined) user.email = payload.email;
    if (payload.user_type !== undefined) user.user_type = payload.user_type;
    (req as AuthRequest).user = user;
    return next();
  } catch {
    return sendError(res, 401, "Invalid or expired token");
  }
}

export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    const user = (req as AuthRequest).user;
    if (!user || !roles.includes(user.user_type ?? "")) {
      return sendError(res, 403, "Not authorized");
    }
    return next();
  };
}