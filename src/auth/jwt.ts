import jwt from "jsonwebtoken";
import { config } from "../shared/config";
import { ApiError } from "../shared/errors";
import { UserRole } from "../types/enums";

export interface TokenPayload {
  sub: string;
  role: UserRole;
  email?: string;
}

export function signToken(
  payload: TokenPayload,
  expiresInSeconds: number = config.jwtExpiresInSeconds,
): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      throw ApiError.unauthorized("Malformed token");
    }
    const role = (decoded as { role?: unknown }).role;
    if (typeof role !== "string" || !Object.values(UserRole).includes(role as UserRole)) {
      throw ApiError.unauthorized("Token is missing a valid role claim");
    }
    const email = (decoded as { email?: unknown }).email;
    return {
      sub: decoded.sub,
      role: role as UserRole,
      ...(typeof email === "string" ? { email } : {}),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.unauthorized("Invalid or expired token");
  }
}
