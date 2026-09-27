import { Response } from "express";
import { Document, ObjectId } from "mongodb";
import { sendSuccess } from "./apiResponse";
import { PaginatedData } from "../types";

/** CLEANUP: with a native driver there is no ODM to hide `_id`/`__v`, so we do it here. */
const NEVER_EXPOSE = new Set(["__v", "passwordHash"]);

/**
 * Converts a Mongo document into the JSON shape the client expects:
 * `_id` becomes a string, `__v` is dropped and credential hashes never ship.
 */
export function serialize<T extends Document>(
  doc: T | null | undefined,
  extra: Record<string, unknown> = {}
): Record<string, unknown> | null {
  if (!doc) return null;
  const plain = typeof (doc as Document).toJSON === "function" ? (doc as Document).toJSON() : { ...doc };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain as Record<string, unknown>)) {
    if (NEVER_EXPOSE.has(key)) continue;
    if (key === "_id" && value instanceof ObjectId) {
      out.id = value.toHexString();
      out._id = value.toHexString();
      continue;
    }
    out[key] = value;
  }
  return { ...out, ...extra };
}

export function serializeMany<T extends Document>(
  docs: T[],
  extraFor?: (doc: T) => Record<string, unknown>
): Record<string, unknown>[] {
  return docs
    .map((doc) => serialize(doc, extraFor ? extraFor(doc) : {}))
    .filter((value): value is Record<string, unknown> => value !== null);
}

export interface PageOptions {
  page: number;
  limit: number;
  skip: number;
}

/** Parses `?page=&limit=` and clamps limit to a sane maximum. */
export function getPagination(query: Record<string, unknown>): PageOptions {
  const rawPage = Number(query.page ?? 1);
  const rawLimit = Number(query.limit ?? 20);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 100) : 20;

  return { page, limit, skip: (page - 1) * limit };
}

export function buildPaginated<T>(
  items: T[],
  total: number,
  options: PageOptions
): PaginatedData<T> {
  const totalPages = Math.max(1, Math.ceil(total / options.limit));
  return {
    items,
    page: options.page,
    limit: options.limit,
    total,
    totalPages,
    hasNextPage: options.page < totalPages,
    hasPrevPage: options.page > 1,
  };
}

/** The standard list-response shortcut used by every paginated endpoint. */
export function sendPaginated<T>(
  res: Response,
  message: string,
  items: T[],
  total: number,
  options: PageOptions
): Response {
  return sendSuccess(res, 200, message, buildPaginated(items, total, options));
}

/**
 * The native driver does not maintain `createdAt`/`updatedAt`, so every write
 * stamps them explicitly. `createdAt` is only ever set on insert.
 */
export function timestamps(existing?: Document): Record<string, Date> {
  const now = new Date();
  if (existing && existing.createdAt instanceof Date) {
    return { updatedAt: now };
  }
  return { createdAt: now, updatedAt: now };
}

/** Turns a query-string flag into a boolean when it is present. */
export function queryFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalised = String(value).toLowerCase();
  if (normalised === "true" || normalised === "1") return true;
  if (normalised === "false" || normalised === "0") return false;
  return undefined;
}

export default {
  serialize,
  serializeMany,
  getPagination,
  buildPaginated,
  sendPaginated,
  timestamps,
  queryFlag,
};
