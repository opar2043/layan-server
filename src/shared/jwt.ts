import jwt, { SignOptions } from "jsonwebtoken";
import { JwtPayload } from "../types";
import { Role } from "../types/enums";

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set — check your .env file");
  }
  return secret;
}

/**
 * Signs a token for an Owner, Staff member or Admin.
 * `businessId` is included for OWNER/STAFF and omitted for ADMIN.
 * Customers never receive a token — they authenticate through Firebase.
 */
export function signToken(payload: {
  id: string;
  role: Role;
  email: string;
  businessId?: string;
}): string {
  const options: SignOptions = {
    expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as SignOptions["expiresIn"],
  };
  return jwt.sign(payload, getSecret(), options);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as JwtPayload;
}

/** Pulls the raw token out of an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
}

export default { signToken, verifyToken, extractBearerToken };
