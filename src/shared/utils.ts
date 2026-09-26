import { randomUUID } from "node:crypto";
import { ApiError } from "./errors";
import type { Paginated } from "./response";

export function generateId(prefix: string): string {
  return `${prefix.replace(/_/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function toDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw ApiError.badRequest(`${field} is not a valid date`);
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw ApiError.badRequest(`${field} must be a valid ISO date string`);
}

export function optionalDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Money is always integer minor units; never accept floats from a client. */
export function toMinor(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw ApiError.badRequest(`${field} must be a number`);
  const rounded = Math.round(parsed);
  if (rounded < 0) throw ApiError.badRequest(`${field} must not be negative`);
  return rounded;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw ApiError.badRequest(`${field} is required`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw ApiError.badRequest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array`);
  return value;
}

/** Reads a positive integer from a query string, clamped to `max`. */
export function queryInt(
  query: Record<string, unknown>,
  key: string,
  fallback: number,
  min = 1,
  max = 200,
): number {
  const raw = query[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function queryBool(query: Record<string, unknown>, key: string): boolean | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  const normalised = String(raw).toLowerCase();
  if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
  if (normalised === "false" || normalised === "0" || normalised === "no") return false;
  return undefined;
}

export function buildPagination(
  page: number,
  pageSize: number,
  total: number,
): Paginated<never> {
  return {
    data: [],
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two `[lng, lat]` GeoJSON coordinate pairs. */
export function distanceKm(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
): number | null {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  if (![lng1, lat1, lng2, lat2].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);
  const a1 =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1Rad) * Math.cos(lat2Rad);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a1)));
}

export function readCoordinates(
  value: unknown,
): readonly number[] | null {
  if (typeof value !== "object" || value === null) return null;
  const geo = value as { type?: unknown; coordinates?: unknown };
  if (geo.type !== "Point" || !Array.isArray(geo.coordinates)) return null;
  return geo.coordinates as number[];
}

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export function dayKeyOf(date: Date): DayKey {
  return DAY_KEYS[date.getUTCDay()] ?? "sun";
}

/** `[["09:00","19:00"], ...]` → minutes-since-midnight ranges. */
export function parseTimeRanges(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const ranges: Array<[number, number]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const start = parseHhMm(entry[0]);
    const end = parseHhMm(entry[1]);
    if (start === null || end === null || end <= start) continue;
    ranges.push([start, end]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

export function parseHhMm(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatHhMm(minutesFromMidnight: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutesFromMidnight)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Start-of-day UTC for a `YYYY-MM-DD` string, with a strict format check. */
export function parseDateKey(value: unknown, field: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw ApiError.badRequest(`${field} must be a YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw ApiError.badRequest(`${field} is not a real date`);
  return parsed;
}

export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/** Strips fields a client must never control, whatever it puts in the body. */
export function stripServerOwnedFields<T>(
  body: Record<string, unknown>,
  extra: readonly string[] = [],
): Partial<T> {
  const blocked = new Set<string>([
    "_id",
    "createdAt",
    "updatedAt",
    "isVerifiedBooking",
    "badges",
    "businessScore",
    "ratingSummary",
    "statusHistory",
    "policySnapshot",
    "slotKey",
    "slotActive",
    ...extra,
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (blocked.has(key)) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}
