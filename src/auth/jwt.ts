import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.JWT_SECRET || "layan-dev-secret";

interface JwtPayload {
  sub: string;
  email?: string;
  user_type?: string;
  iat: number;
  exp: number;
}

function toBase64Url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(data: string): string {
  return createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function signToken(
  payload: Record<string, unknown>,
  expiresInSeconds = 60 * 60 * 24
): string {
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = toBase64Url(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      ...payload,
    })
  );
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

export function verifyToken(token: string): JwtPayload {
  const [header, body, signature] = token.split(".");

  if (!header || !body || !signature) throw new Error("Malformed token");

  const expected = sign(`${header}.${body}`);
  const actual = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");

  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(fromBase64Url(body)) as JwtPayload & Record<string, unknown>;

  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");

  return payload;
}