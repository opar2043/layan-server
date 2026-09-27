import { ObjectId } from "mongodb";
import { ApiError } from "./apiError";

/**
 * Request validation, hand-written because there is no ODM doing it for us.
 * Every helper throws ApiError.badRequest, which the global errorHandler turns
 * into a 400 — so validation failures never leak as 500s.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_RE.test(value);
}

/** Throws 400 unless the value is a valid 24-char ObjectId string. */
export function toObjectId(value: unknown, field = "id"): ObjectId {
  if (!isValidId(value)) {
    throw ApiError.badRequest(`Invalid ${field}: expected a 24-character hex ObjectId`);
  }
  return new ObjectId(value);
}

/** Same as toObjectId but allows null/undefined/"" (for optional ref fields). */
export function toObjectIdOrNull(value: unknown, field = "id"): ObjectId | null {
  if (value === null || value === undefined || value === "") return null;
  return toObjectId(value, field);
}

type Body = Record<string, unknown>;

export function requireString(
  body: Body,
  field: string,
  opts: { min?: number; max?: number } = {}
): string {
  const raw = body[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw ApiError.badRequest(`"${field}" is required and must be a non-empty string`);
  }
  const value = raw.trim();
  if (opts.min !== undefined && value.length < opts.min) {
    throw ApiError.badRequest(`"${field}" must be at least ${opts.min} characters`);
  }
  if (opts.max !== undefined && value.length > opts.max) {
    throw ApiError.badRequest(`"${field}" must be at most ${opts.max} characters`);
  }
  return value;
}

export function optionalString(
  body: Body,
  field: string,
  opts: { min?: number; max?: number } = {}
): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  if (typeof body[field] !== "string") {
    throw ApiError.badRequest(`"${field}" must be a string`);
  }
  if (body[field].trim().length === 0) return undefined;
  return requireString(body, field, opts);
}

export function requireNumber(
  body: Body,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const raw = body[field];
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw ApiError.badRequest(`"${field}" is required and must be a number`);
  }
  if (opts.integer && !Number.isInteger(raw)) {
    throw ApiError.badRequest(`"${field}" must be an integer`);
  }
  if (opts.min !== undefined && raw < opts.min) {
    throw ApiError.badRequest(`"${field}" must be greater than or equal to ${opts.min}`);
  }
  if (opts.max !== undefined && raw > opts.max) {
    throw ApiError.badRequest(`"${field}" must be less than or equal to ${opts.max}`);
  }
  return raw;
}

export function optionalNumber(
  body: Body,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  if (typeof body[field] !== "number") {
    throw ApiError.badRequest(`"${field}" must be a number`);
  }
  return requireNumber(body, field, opts);
}

export function requireBoolean(body: Body, field: string, fallback?: boolean): boolean {
  if (body[field] === undefined || body[field] === null) {
    if (fallback !== undefined) return fallback;
    throw ApiError.badRequest(`"${field}" is required and must be a boolean`);
  }
  if (typeof body[field] !== "boolean") {
    throw ApiError.badRequest(`"${field}" must be a boolean`);
  }
  return body[field];
}

export function optionalBoolean(body: Body, field: string): boolean | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  if (typeof body[field] !== "boolean") {
    throw ApiError.badRequest(`"${field}" must be a boolean`);
  }
  return body[field];
}

/** Validates against a closed value set (TS enum) and returns the matching member. */
export function requireEnum<T extends Record<string, string>>(
  body: Body,
  field: string,
  allowed: T
): T[keyof T] {
  const raw = body[field];
  if (typeof raw !== "string") {
    throw ApiError.badRequest(`"${field}" is required`, { allowed: Object.values(allowed) });
  }
  const match = (Object.values(allowed) as string[]).includes(raw);
  if (!match) {
    throw ApiError.badRequest(`"${field}" has an invalid value`, {
      received: raw,
      allowed: Object.values(allowed),
    });
  }
  return raw as T[keyof T];
}

export function optionalEnum<T extends Record<string, string>>(
  body: Body,
  field: string,
  allowed: T
): T[keyof T] | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requireEnum(body, field, allowed);
}

/** Accepts a Date or an ISO-8601 string; always returns a Date. */
export function requireDate(body: Body, field: string): Date {
  const raw = body[field];
  const date = raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`"${field}" is required and must be a valid date`);
  }
  return date;
}

export function optionalDate(body: Body, field: string): Date | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requireDate(body, field);
}

export function requireId(body: Body, field: string): ObjectId {
  if (body[field] === undefined || body[field] === null) {
    throw ApiError.badRequest(`"${field}" is required`);
  }
  return toObjectId(body[field], field);
}

export function optionalId(body: Body, field: string): ObjectId | null {
  return toObjectIdOrNull(body[field], field);
}

export function requireStringArray(body: Body, field: string): string[] {
  const raw = body[field];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw ApiError.badRequest(`"${field}" is required and must be an array of strings`);
  }
  return raw as string[];
}

export function optionalStringArray(body: Body, field: string): string[] | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requireStringArray(body, field);
}

/** Generic free-form object, used for `consultationForm` (Mongoose Mixed). */
export function optionalRecord(
  body: Body,
  field: string
): Record<string, unknown> | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.badRequest(`"${field}" must be an object`);
  }
  return raw as Record<string, unknown>;
}

export function requireRecord(body: Body, field: string): Record<string, unknown> {
  const value = optionalRecord(body, field);
  if (value === undefined) {
    throw ApiError.badRequest(`"${field}" is required and must be an object`);
  }
  return value;
}

export function requireEmail(body: Body, field = "email"): string {
  const value = requireString(body, field);
  if (!EMAIL_RE.test(value)) {
    throw ApiError.badRequest(`"${field}" must be a valid email address`);
  }
  return value.toLowerCase();
}

/** Passwords are checked for presence/strength here; hashing happens in controllers. */
export function requirePassword(body: Body, field = "password", min = 8): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (value.length < min) {
    throw ApiError.badRequest(`"${field}" must be at least ${min} characters`);
  }
  return value;
}

/** Drops undefined values so a partial PATCH never nulls out untouched fields. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * Restricts an update document to an allow-list. Used by every owner/admin PATCH
 * so a client can never set privilege fields like passwordHash or verificationStatus.
 */
export function pick<T extends Record<string, unknown>>(
  source: Record<string, unknown>,
  allowed: readonly (keyof T)[]
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key as string] !== undefined) {
      out[key as string] = source[key as string];
    }
  }
  return out as Partial<T>;
}

export default {
  isValidId,
  toObjectId,
  toObjectIdOrNull,
  requireString,
  optionalString,
  requireNumber,
  optionalNumber,
  requireBoolean,
  optionalBoolean,
  requireEnum,
  optionalEnum,
  requireDate,
  optionalDate,
  requireId,
  optionalId,
  requireStringArray,
  optionalStringArray,
  optionalRecord,
  requireRecord,
  requireEmail,
  requirePassword,
  compact,
  pick,
};
