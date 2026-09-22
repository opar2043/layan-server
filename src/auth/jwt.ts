import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "layan-dev-secret";

export interface TokenPayload {
  sub: string;
  email?: string;
  user_type?: string;
}



export function signToken(payload: TokenPayload, expiresInSeconds = 60 * 60 * 24): string {
  return jwt.sign(payload, SECRET, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, SECRET) as TokenPayload & { iat: number; exp: number };
}