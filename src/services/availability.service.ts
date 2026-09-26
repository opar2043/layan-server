import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { ApiError } from "../shared/errors";
import { config } from "../shared/config";
import {
  addDays,
  dateKeyOf,
  dayKeyOf,
  parseDateKey,
  parseHhMm,
  parseTimeRanges,
  readCoordinates,
  distanceKm,
  toDate,
} from "../shared/utils";
import type {
  BookingDoc,
  BusinessDoc,
  LocationDoc,
  ServiceDoc,
  StaffDoc,
} from "../types/domain";
import { ACTIVE_BOOKING_STATUSES } from "../types/enums";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A half-open `[start, end)` window in absolute epoch milliseconds. */
interface Window {
  start: number;
  end: number;
}

interface BusyBlock extends Window {
  kind: "booking" | "timeoff";
}

export interface Slot {
  startAt: string;
  endAt: string;
  /** The instant from which this slot may be booked (start minus lead time). */
  bookableFrom: string;
  staffId: string;
  staffName: string;
  locationId: string;
  priceMinor: number;
  currency: string;
  /**
   * Smart Gap Protection score, 0–100. Higher means booking this slot removes
   * more fragmentation from that staff member's day.
   */
  gapScore: number;
  gapMinutesFilled: number;
  recommendation: "gap_fill" | "tail_fill" | "standard";
  depositRequired: boolean;
  depositMinor: number;
  requiresConsultationFormId: string | null;
  instantBook: boolean;
  distanceKm: number | null;
}

export interface AvailabilityQuery {
  businessId: string;
  serviceId: string;
  locationId?: string;
  staffId?: string;
  dateFrom: Date;
  dateTo: Date;
  fromCoordinates?: readonly number[] | null;
}

export async function resolveService(
  businessId: string,
  serviceId: string,
): Promise<ServiceDoc> {
  const service = await getCollection<ServiceDoc>(Collections.services).findOne({
    _id: serviceId,
    businessId,
  });
  if (!service) throw ApiError.notFound("Service not found");
  if (service.isActive !== true) throw ApiError.unprocessable("This service is not bookable");
  return service;
}

/** The price this specific staff member charges, honouring the private override list. */
export function priceForStaff(service: ServiceDoc, staffId: string): number {
  const override = (service.staffPricing ?? []).find((entry) => entry.staffId === staffId);
  return override?.priceMinor ?? service.priceMinor;
}

export function depositFor(
  service: ServiceDoc,
  totalMinor: number,
): { required: boolean; amountMinor: number } {
  const rule = service.depositRule;
  if (!rule || rule.type === "none" || rule.value <= 0) {
    return { required: false, amountMinor: 0 };
  }
  const amountMinor =
    rule.type === "percentage"
      ? Math.round((totalMinor * rule.value) / 100)
      : Math.min(rule.value, totalMinor);
  return { required: amountMinor > 0, amountMinor };
}

function toAbsolute(dayStartMs: number, ranges: ReadonlyArray<[number, number]>): Window[] {
  return ranges.map(([start, end]) => ({
    start: dayStartMs + start * MINUTE,
    end: dayStartMs + end * MINUTE,
  }));
}

function intersect(a: readonly Window[], b: readonly Window[]): Window[] {
  const out: Window[] = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function subtract(base: readonly Window[], cuts: readonly BusyBlock[]): Window[] {
  let working = base.map((interval) => ({ ...interval }));
  for (const cut of cuts) {
    const next: Window[] = [];
    for (const interval of working) {
      if (cut.end <= interval.start || cut.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (cut.start > interval.start) next.push({ start: interval.start, end: cut.start });
      if (cut.end < interval.end) next.push({ start: cut.end, end: interval.end });
    }
    working = next.sort((x, y) => x.start - y.start);
  }
  return working;
}

/** Location hours for a day; `customHours` (holidays, short days) wins over the weekly pattern. */
export function locationHoursFor(
  location: LocationDoc,
  day: Date,
): Array<[number, number]> {
  const key = dateKeyOf(day);
  const custom = (location.customHours ?? []).find((entry) => entry.date === key);
  if (custom) {
    if (custom.closed === true) return [];
    const open = parseHhMm(custom.open);
    const close = parseHhMm(custom.close);
    return open === null || close === null || close <= open ? [] : [[open, close]];
  }
  return parseTimeRanges(location.openingHours?.[dayKeyOf(day)]);
}

function recurrenceCovers(recurrence: unknown, day: Date): boolean {
  if (typeof recurrence !== "object" || recurrence === null) return false;
  const rule = recurrence as { freq?: unknown; byWeekday?: unknown; until?: unknown };
  if (rule.freq !== "weekly") return false;
  const until = typeof rule.until === "string" ? new Date(rule.until) : null;
  if (until && day.getTime() > until.getTime()) return false;
  const byWeekday = Array.isArray(rule.byWeekday) ? (rule.byWeekday as string[]) : [];
  if (byWeekday.length === 0) return true;
  return byWeekday.includes(dayKeyOf(day));
}

async function loadBusyBlocks(
  businessId: string,
  staffIds: readonly string[],
  buffers: { before: number; after: number },
  from: Date,
  to: Date,
): Promise<Map<string, BusyBlock[]>> {
  const blocks = new Map<string, BusyBlock[]>();
  for (const staffId of staffIds) blocks.set(staffId, []);

  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const ids = [...staffIds];

  const [bookings, timeOffs] = await Promise.all([
    getCollection<BookingDoc>(Collections.bookings)
      .find({
        businessId,
        staffId: { $in: ids },
        status: { $in: [...ACTIVE_BOOKING_STATUSES] },
        startAt: { $lt: toIso },
        endAt: { $gt: fromIso },
      })
      .toArray(),
    getCollection(Collections.timeOffs)
      .find({ businessId, staffId: { $in: ids } })
      .toArray(),
  ]);

  for (const booking of bookings) {
    const list = blocks.get(booking.staffId);
    if (!list) continue;
    const start = new Date(booking.startAt).getTime();
    const end = new Date(booking.endAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    list.push({
      start: start - buffers.before * MINUTE,
      end: end + buffers.after * MINUTE,
      kind: "booking",
    });
  }

  const windowStart = from.getTime();
  const windowEnd = to.getTime() + DAY;

  for (const off of timeOffs) {
    const staffId = typeof off.staffId === "string" ? off.staffId : null;
    if (!staffId) continue;
    const list = blocks.get(staffId);
    if (!list) continue;

    const startAt = new Date(String(off.startAt));
    const endAt = new Date(String(off.endAt));
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) continue;

    if (off.recurrence === null || off.recurrence === undefined) {
      if (endAt.getTime() <= windowStart || startAt.getTime() >= windowEnd) continue;
      list.push({ start: startAt.getTime(), end: endAt.getTime(), kind: "timeoff" });
      continue;
    }

    // Recurring (e.g. weekly lunch breaks): expand once per covered day.
    if (off.allDay === true) {
      for (let day = new Date(from); day.getTime() <= to.getTime(); day = addDays(day, 1)) {
        if (!recurrenceCovers(off.recurrence, day)) continue;
        const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
        list.push({ start: dayStart, end: dayStart + DAY, kind: "timeoff" });
      }
      continue;
    }

    const spanDays = Math.max(
      0,
      Math.round((endAt.getTime() - startAt.getTime()) / DAY),
    );
    const dailyStartMinutes = startAt.getUTCHours() * 60 + startAt.getUTCMinutes();
    const dailyLength = Math.max(1, endAt.getTime() - startAt.getTime());

    for (let day = new Date(from); day.getTime() <= to.getTime(); day = addDays(day, 1)) {
      if (!recurrenceCovers(off.recurrence, day)) continue;
      const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      for (let offset = 0; offset <= spanDays; offset += 1) {
        const occurrenceStart = dayStart + offset * DAY + dailyStartMinutes * MINUTE;
        list.push({
          start: occurrenceStart,
          end: occurrenceStart + dailyLength,
          kind: "timeoff",
        });
      }
    }
  }

  return blocks;
}

/**
 * Smart Gap Protection.
 *
 * Ranks a candidate by how much it repairs the fragmentation of that staff
 * member's day rather than by "soonest first". A slot that exactly fills a hole
 * between two bookings scores highest; one that leaves a useless 5-minute
 * remainder is penalised, because a fragment too short to sell still costs a
 * slot boundary on the calendar.
 */
export function scoreGap(
  candidate: Window,
  freeWindows: readonly Window[],
  serviceDurationMin: number,
): { score: number; minutesFilled: number; recommendation: Slot["recommendation"] } {
  const threshold = config.availability.fragmentationThresholdMinutes;
  const serviceMs = serviceDurationMin * MINUTE;

  const host = freeWindows.find(
    (w) => candidate.start >= w.start && candidate.end <= w.end,
  );
  if (!host) return { score: 0, minutesFilled: 0, recommendation: "standard" };

  const residualBefore = (candidate.start - host.start) / MINUTE;
  const residualAfter = (host.end - candidate.end) / MINUTE;
  const residual = residualBefore + residualAfter;

  // Residual time that is too short to sell again is pure fragmentation.
  const deadFragments = [residualBefore, residualAfter].filter(
    (minutes) => minutes > 0 && minutes < threshold,
  );

  let score = Math.min(100, (serviceDurationMin / 60) * 100);

  if (residual === 0) {
    score += 40; // consumes the hole completely
  } else {
    score -= deadFragments.length * 18;
    const fillRatio = serviceDurationMin / (serviceDurationMin + residual);
    score += fillRatio * 20;
  }

  // Filling the last free window of the day stops the remainder rolling into
  // tomorrow as one dead block.
  if (residualAfter === 0) score += 8;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    minutesFilled: serviceDurationMin,
    recommendation:
      residual === 0 ? "gap_fill" : deadFragments.length > 0 ? "standard" : "tail_fill",
  };
}

/**
 * Live calendar slots for a service. Respects staff hours, location custom hours,
 * time off (including weekly recurrence), service buffers, lead time, the advance
 * booking horizon, and existing active bookings.
 */
export async function computeAvailability(query: AvailabilityQuery): Promise<Slot[]> {
  const service = await resolveService(query.businessId, query.serviceId);
  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: query.businessId,
  });
  if (!business) throw ApiError.notFound("Business not found");

  const locationFilter: Record<string, unknown> = { businessId: query.businessId, status: "active" };
  if (query.locationId) {
    locationFilter._id = query.locationId;
  } else if (Array.isArray(service.locationIds) && service.locationIds.length > 0) {
    locationFilter._id = { $in: service.locationIds };
  }

  const locations = await getCollection<LocationDoc>(Collections.locations)
    .find(locationFilter)
    .toArray();
  if (locations.length === 0) {
    throw ApiError.notFound("This service has no bookable location");
  }

  const staffFilter: Record<string, unknown> = {
    businessId: query.businessId,
    status: "active",
    bookable: true,
  };
  if (query.staffId) {
    staffFilter._id = query.staffId;
  }

  const staffMembers = await getCollection<StaffDoc>(Collections.staff)
    .find(staffFilter)
    .toArray();

  const eligible = staffMembers.filter((member) => {
    if (Array.isArray(service.staffIds) && service.staffIds.length > 0) {
      if (!service.staffIds.includes(member._id)) return false;
    }
    if (Array.isArray(member.serviceIds) && member.serviceIds.length > 0) {
      if (!member.serviceIds.includes(service._id)) return false;
    }
    return member.locationIds === undefined || member.locationIds.length === 0
      ? true
      : member.locationIds.some((id) =>
          locations.some((location) => location._id === id),
        );
  });

  if (eligible.length === 0) return [];

  const durationMin = service.durationMin;
  const bufferBefore = service.bufferBeforeMin ?? 0;
  const bufferAfter = service.bufferAfterMin ?? 0;

  const blocks = await loadBusyBlocks(
    query.businessId,
    eligible.map((member) => member._id),
    { before: Math.max(0, bufferBefore), after: Math.max(0, bufferAfter) },
    query.dateFrom,
    query.dateTo,
  );

  const leadTimeMin = service.leadTimeMinutes ?? config.availability.defaultLeadTimeMinutes;
  const maxAdvanceDays = service.maxAdvanceDays ?? config.availability.defaultMaxAdvanceDays;
  const nowMs = Date.now();
  const horizonLimitMs = nowMs + maxAdvanceDays * DAY;

  const slots: Slot[] = [];
  const customerHome = query.fromCoordinates ?? null;
  const lastDay = query.dateTo.getTime();

  for (const staff of eligible) {
    const staffBlocks = blocks.get(staff._id) ?? [];
    const staffLocationIds = staff.locationIds ?? [];

    for (const location of locations) {
      if (staffLocationIds.length > 0 && !staffLocationIds.includes(location._id)) continue;

      const locationGeo = readCoordinates(location.geo);
      const distance =
        customerHome && locationGeo ? distanceKm(customerHome, locationGeo) : null;

      for (let dayMs = startOfDay(query.dateFrom); dayMs <= lastDay; dayMs += DAY) {
        if (dayMs > horizonLimitMs) break;
        const day = new Date(dayMs);

        const locationRanges = locationHoursFor(location, day);
        if (locationRanges.length === 0) continue;

        const workingRanges = parseTimeRanges(staff.workingHours?.[dayKeyOf(day)]);
        const dayWindow =
          workingRanges.length > 0
            ? intersect(toAbsolute(dayMs, locationRanges), toAbsolute(dayMs, workingRanges))
            : toAbsolute(dayMs, locationRanges);
        if (dayWindow.length === 0) continue;

        const free = subtract(dayWindow, staffBlocks);
        if (free.length === 0) continue;

        for (const window of free) {
          // Walk the free window in service-length steps. The final step is only
          // emitted when the service plus buffers actually fit.
          for (
            let cursor = window.start;
            cursor + durationMin * MINUTE <= window.end;
            cursor += durationMin * MINUTE
          ) {
            const startAt = cursor;
            const endAt = cursor + durationMin * MINUTE;
            const bookableFrom = startAt - leadTimeMin * MINUTE;
            if (bookableFrom <= nowMs) continue;

            const gap = scoreGap({ start: startAt, end: endAt }, free, durationMin);
            const priceMinor = priceForStaff(service, staff._id);
            const deposit = depositFor(service, priceMinor);

            slots.push({
              startAt: new Date(startAt).toISOString(),
              endAt: new Date(endAt).toISOString(),
              bookableFrom: new Date(bookableFrom).toISOString(),
              staffId: staff._id,
              staffName: staff.displayName,
              locationId: location._id,
              priceMinor,
              currency: service.currency,
              gapScore: gap.score,
              gapMinutesFilled: gap.minutesFilled,
              recommendation: gap.recommendation,
              depositRequired: deposit.required,
              depositMinor: deposit.amountMinor,
              requiresConsultationFormId: service.requiresConsultationFormId ?? null,
              instantBook: (service.instantBook ?? false) || (business.instantBook ?? false),
              distanceKm: distance === null ? null : Math.round(distance * 100) / 100,
            });
          }
        }
      }
    }
  }

  slots.sort((a, b) => {
    if (b.gapScore !== a.gapScore) return b.gapScore - a.gapScore;
    return a.startAt.localeCompare(b.startAt);
  });

  return slots;
}

function startOfDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export interface AvailabilityRequestOptions {
  businessId: string;
  serviceId: string;
  locationId?: string;
  staffId?: string;
  date?: string;
  days?: number;
  coordinates?: readonly number[] | null;
}

export function parseAvailabilityRequest(options: AvailabilityRequestOptions): {
  dateFrom: Date;
  dateTo: Date;
} {
  const now = new Date();
  const dateFrom = options.date ? parseDateKey(options.date, "date") : now;
  const days = Math.min(
    60,
    Math.max(1, options.days ?? config.availability.defaultHorizonDays),
  );
  return { dateFrom, dateTo: addDays(dateFrom, days - 1) };
}

/**
 * Re-validates that a requested start time is genuinely bookable right now.
 * A slot that disappeared between the availability call and the booking call is a
 * 409, not a silent overwrite.
 */
export async function assertSlotIsFree(
  businessId: string,
  serviceId: string,
  startAtIso: string,
  staffId: string,
  locationId?: string,
): Promise<Slot> {
  const startAt = toDate(startAtIso, "startAt");
  const dayStart = new Date(startOfDay(startAt));

  const slots = await computeAvailability({
    businessId,
    serviceId,
    ...(locationId ? { locationId } : {}),
    staffId,
    dateFrom: dayStart,
    dateTo: dayStart,
    fromCoordinates: null,
  });

  const target = startAt.getTime();
  const match = slots.find(
    (slot) => slot.staffId === staffId && new Date(slot.startAt).getTime() === target,
  );
  if (!match) {
    throw ApiError.conflict("That slot is no longer available", { startAt: startAtIso });
  }
  return match;
}
