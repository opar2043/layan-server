import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import {
  addDays,
  generateId,
  isoNow,
  readCoordinates,
  distanceKm,
  queryInt,
} from "../shared/utils";
import { ApiError } from "../shared/errors";
import { computeAvailability, type Slot } from "./availability.service";
import type {
  AppDocument,
  BookingDoc,
  BusinessDoc,
  CategoryDoc,
  LocationDoc,
  ReviewDoc,
  ServiceDoc,
  StaffDoc,
} from "../types/domain";

export interface SearchFilters {
  q?: string;
  categoryId?: string;
  categorySlug?: string;
  serviceId?: string;
  locationId?: string;
  city?: string;
  postcode?: string;
  lat?: number;
  lng?: number;
  maxPriceMinor?: number;
  minPriceMinor?: number;
  minRating?: number;
  providerGender?: string;
  maxDistanceKm?: number;
  openNow?: boolean;
  instantBook?: boolean;
  mobileService?: boolean;
  limit: number;
  page: number;
}

export interface SearchResultItem {
  business: Record<string, unknown>;
  distanceKm: number | null;
  matchedServices: Array<Record<string, unknown>>;
  nextAvailableSlot: { startAt: string; staffId: string; staffName: string } | null;
  isOpenNow: boolean;
  reasons: string[];
}

export interface SearchResponse {
  items: SearchResultItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  appliedFilters: SearchFilters;
}

function readQuery(query: Record<string, unknown>): SearchFilters {
  const num = (key: string): number | undefined => {
    const raw = query[key];
    if (raw === undefined || raw === null || raw === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const str = (key: string): string | undefined => {
    const raw = query[key];
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const raw = query[key];
    if (raw === undefined) return undefined;
    const normalised = String(raw).toLowerCase();
    if (normalised === "true" || normalised === "1") return true;
    if (normalised === "false" || normalised === "0") return false;
    return undefined;
  };

  const maxDistanceKm = num("maxDistanceKm");
  const maxDistance = maxDistanceKm ?? num("radiusKm");

  return {
    ...(str("q") ? { q: str("q") as string } : {}),
    ...(str("categoryId") ? { categoryId: str("categoryId") as string } : {}),
    ...(str("categorySlug") ? { categorySlug: str("categorySlug") as string } : {}),
    ...(str("serviceId") ? { serviceId: str("serviceId") as string } : {}),
    ...(str("locationId") ? { locationId: str("locationId") as string } : {}),
    ...(str("city") ? { city: str("city") as string } : {}),
    ...(str("postcode") ? { postcode: str("postcode") as string } : {}),
    ...(num("lat") === undefined ? {} : { lat: num("lat") as number }),
    ...(num("lng") === undefined ? {} : { lng: num("lng") as number }),
    ...(num("maxPriceMinor") === undefined ? {} : { maxPriceMinor: num("maxPriceMinor") as number }),
    ...(num("minPriceMinor") === undefined ? {} : { minPriceMinor: num("minPriceMinor") as number }),
    ...(num("minRating") === undefined ? {} : { minRating: num("minRating") as number }),
    ...(str("providerGender") ? { providerGender: str("providerGender") as string } : {}),
    ...(maxDistance === undefined ? {} : { maxDistanceKm: maxDistance }),
    ...(bool("openNow") === undefined ? {} : { openNow: bool("openNow") as boolean }),
    ...(bool("instantBook") === undefined ? {} : { instantBook: bool("instantBook") as boolean }),
    ...(bool("mobileService") === undefined ? {} : { mobileService: bool("mobileService") as boolean }),
    limit: queryInt(query, "limit", 20, 1, 50),
    page: queryInt(query, "page", 1, 1, 500),
  };
}

function isOpenNow(location: LocationDoc, now: Date): boolean {
  const key = now.toISOString().slice(0, 10);
  const custom = (location.customHours ?? []).find((entry) => entry.date === key);
  if (custom) {
    if (custom.closed === true) return false;
    if (!custom.open || !custom.close) return false;
    return now.getTime() >= minutesOf(custom.open) && now.getTime() <= minutesOf(custom.close);
  }
  const dayIndex = now.getUTCDay();
  const keyName = (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[dayIndex] ?? "sun";
  const ranges = location.openingHours?.[keyName] ?? [];
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  return ranges.some(
    (range) =>
      Array.isArray(range) && range.length >= 2 && current >= minutesOf(range[0]) && current <= minutesOf(range[1]),
  );
}

function minutesOf(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Earliest genuinely bookable slot across the business's staff.
 *
 * This must come from the availability engine, not from the next confirmed
 * booking: a busy slot is exactly what a customer must *not* be shown.
 */
async function nextSlotFor(
  businessId: string,
  serviceIds: string[],
): Promise<{ startAt: string; staffId: string; staffName: string; serviceId: string } | null> {
  const staffDocs = await getCollection<StaffDoc>(Collections.staff)
    .find({ businessId, status: "active", bookable: true })
    .toArray();
  if (staffDocs.length === 0) return null;
  const names = new Map(staffDocs.map((doc) => [doc._id, doc.displayName]));

  let best: { startAt: string; staffId: string; serviceId: string } | null = null;

  for (const serviceId of serviceIds) {
    let slots: Slot[];
    try {
      slots = await computeAvailability({
        businessId,
        serviceId,
        dateFrom: new Date(),
        dateTo: addDays(new Date(), 7),
        fromCoordinates: null,
      });
    } catch {
      // An inactive or misconfigured service simply offers no next slot.
      continue;
    }
    for (const slot of slots) {
      if (best && slot.startAt >= best.startAt) continue;
      best = { startAt: slot.startAt, staffId: slot.staffId, serviceId };
    }
  }

  if (!best) return null;
  return {
    startAt: best.startAt,
    staffId: best.staffId,
    staffName: names.get(best.staffId) ?? "Staff",
    serviceId: best.serviceId,
  };
}

export async function search(filters: SearchFilters): Promise<SearchResponse> {
  const businessFilter: Record<string, unknown> = { status: "active" };

  if (filters.categoryId) businessFilter.categoryIds = filters.categoryId;
  if (filters.categorySlug) {
    const category = await getCollection<CategoryDoc>(Collections.categories).findOne({
      slug: filters.categorySlug,
    });
    if (category) businessFilter.categoryIds = category._id;
  }
  if (filters.instantBook) businessFilter.instantBook = true;
  if (filters.mobileService) businessFilter.isMobileService = true;
  if (filters.minRating !== undefined) {
    businessFilter["ratingSummary.average"] = { $gte: filters.minRating };
  }
  if (filters.q) {
    const escaped = filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    businessFilter.$or = [{ name: regex }, { description: regex }, { amenities: regex }];
  }

  const businesses = await getCollection<BusinessDoc>(Collections.businesses)
    .find(businessFilter)
    .toArray();

  if (businesses.length === 0) {
    return {
      items: [],
      page: filters.page,
      pageSize: filters.limit,
      total: 0,
      totalPages: 0,
      appliedFilters: filters,
    };
  }

  const businessIds = businesses.map((business) => business._id);
  const allLocations = await getCollection<LocationDoc>(Collections.locations)
    .find({ businessId: { $in: businessIds }, status: "active" })
    .toArray();
  const allServices = await getCollection<ServiceDoc>(Collections.services)
    .find({ businessId: { $in: businessIds }, isActive: true })
    .toArray();
  const allStaff = await getCollection<StaffDoc>(Collections.staff)
    .find({ businessId: { $in: businessIds }, status: "active" })
    .toArray();

  const origin: readonly number[] | null =
    filters.lat !== undefined && filters.lng !== undefined ? [filters.lng, filters.lat] : null;

  const now = new Date();
  const items: SearchResultItem[] = [];

  for (const business of businesses) {
    const reasons: string[] = [];

    const locations = allLocations.filter(
      (location) =>
        location.businessId === business._id &&
        (!filters.locationId || location._id === filters.locationId) &&
        (!filters.city ||
          (location.address?.city ?? "").toLowerCase().includes(filters.city.toLowerCase())) &&
        (!filters.postcode ||
          (location.address?.postcode ?? "")
            .toLowerCase()
            .replace(/\s/g, "")
            .startsWith(filters.postcode.toLowerCase().replace(/\s/g, ""))),
    );
    if (allLocations.some((location) => location.businessId === business._id) && locations.length === 0) {
      continue;
    }

    const distances = locations
      .map((location) => (origin ? distanceKm(origin, readCoordinates(location.geo)) : null))
      .filter((value): value is number => value !== null);
    const nearest = distances.length > 0 ? Math.min(...distances) : null;
    if (filters.maxDistanceKm !== undefined && nearest !== null && nearest > filters.maxDistanceKm) {
      continue;
    }

    const openNow = locations.some((location) => isOpenNow(location, now));
    if (filters.openNow === true && !openNow) continue;
    if (filters.openNow === false && openNow) continue;

    let matchedServices = allServices.filter(
      (service) => service.businessId === business._id,
    );
    if (filters.serviceId) {
      matchedServices = matchedServices.filter((service) => service._id === filters.serviceId);
      if (matchedServices.length === 0) continue;
    }
    if (filters.maxPriceMinor !== undefined) {
      matchedServices = matchedServices.filter(
        (service) => service.priceMinor <= (filters.maxPriceMinor as number),
      );
    }
    if (filters.minPriceMinor !== undefined) {
      matchedServices = matchedServices.filter(
        (service) => service.priceMinor >= (filters.minPriceMinor as number),
      );
    }
    if (filters.q) {
      const needle = filters.q.toLowerCase();
      const tagged = matchedServices.filter(
        (service) =>
          service.name.toLowerCase().includes(needle) ||
          (service.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)),
      );
      if (tagged.length > 0) matchedServices = tagged;
    }

    if (filters.providerGender) {
      const wanted = filters.providerGender.toLowerCase();
      const staffForBusiness = allStaff.filter((staff) => staff.businessId === business._id);
      if (wanted !== "any") {
        const gendered = await filterStaffByGender(staffForBusiness, wanted);
        matchedServices = matchedServices.filter(
          (service) =>
            (service.staffIds ?? []).some((staffId) => gendered.has(staffId)) ||
            (service.staffIds ?? []).length === 0,
        );
        if (matchedServices.length === 0) continue;
      }
    }

    if (business.instantBook) reasons.push("instant_book");
    if (business.verification?.businessVerified) reasons.push("business_verified");
    if (openNow) reasons.push("open_now");
    if (nearest !== null) reasons.push("within_distance");
    if ((business.ratingSummary?.average ?? 0) >= 4.5) reasons.push("highly_rated");

    items.push({
      business: business as unknown as Record<string, unknown>,
      distanceKm: nearest === null ? null : Math.round(nearest * 100) / 100,
      matchedServices: matchedServices.slice(0, 5).map((service) => ({
        _id: service._id,
        name: service.name,
        durationMin: service.durationMin,
        priceMinor: service.priceMinor,
        currency: service.currency,
        instantBook: service.instantBook === true,
      })),
      nextAvailableSlot: await nextSlotFor(
        business._id,
        matchedServices.map((service) => service._id),
      ),
      isOpenNow: openNow,
      reasons,
    });
  }

  items.sort((a, b) => {
    const scoreA = a.distanceKm ?? Number.MAX_SAFE_INTEGER;
    const scoreB = b.distanceKm ?? Number.MAX_SAFE_INTEGER;
    if (scoreA !== scoreB) return scoreA - scoreB;
    const ratingA = (a.business.ratingSummary as { average?: number } | undefined)?.average ?? 0;
    const ratingB = (b.business.ratingSummary as { average?: number } | undefined)?.average ?? 0;
    return ratingB - ratingA;
  });

  const total = items.length;
  const start = (filters.page - 1) * filters.limit;
  return {
    items: items.slice(start, start + filters.limit),
    page: filters.page,
    pageSize: filters.limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / filters.limit),
    appliedFilters: filters,
  };
}

async function filterStaffByGender(
  staff: StaffDoc[],
  gender: string,
): Promise<Set<string>> {
  const users = await getCollection(Collections.users)
    .find({ _id: { $in: staff.map((doc) => doc.userId) } })
    .toArray();
  const genderByUser = new Map(users.map((user) => [user._id, String(user.gender ?? "").toLowerCase()]));
  return new Set(
    staff
      .filter((doc) => genderByUser.get(doc.userId) === gender)
      .map((doc) => doc._id),
  );
}

export function parseSearchQuery(query: Record<string, unknown>): SearchFilters {
  return readQuery(query);
}

export interface ParsedQuery {
  category?: string;
  service?: string;
  near?: string;
  date?: string;
  afterTime?: string;
  beforeTime?: string;
  maxPriceMinor?: number;
  providerGender?: string;
  openNow?: boolean;
  instantBook?: boolean;
  raw: string;
}

const DAY_WORDS: Record<string, number> = {
  today: 0,
  tonight: 0,
  tomorrow: 1,
  "day after tomorrow": 2,
};

const MONEY_TO_MINOR: Record<string, number> = {
  "10": 1000, "15": 1500, "20": 2000, "25": 2500, "30": 3000, "40": 4000,
  "50": 5000, "60": 6000, "75": 7500, "80": 8000, "100": 10000,
};

/**
 * Layan Smart Search. Deterministic natural-language parsing — no external model,
 * so it never fails or bills. The raw query and the parsed filters are both stored
 * in `userActivities` so results can be explained and re-ranked later.
 */
export function parseNaturalLanguageQuery(input: string, now = new Date()): ParsedQuery {
  const raw = input.trim();
  const text = ` ${raw.toLowerCase()} `;
  const parsed: ParsedQuery = { raw };

  for (const [word, offset] of Object.entries(DAY_WORDS)) {
    if (text.includes(` ${word} `) || text.includes(` ${word}`)) {
      const target = new Date(now);
      target.setUTCDate(target.getUTCDate() + offset);
      parsed.date = target.toISOString().slice(0, 10);
      break;
    }
  }
  if (!parsed.date) {
    const inDays = /\bin (\d{1,2}) days?\b/.exec(text);
    if (inDays?.[1]) {
      const target = new Date(now);
      target.setUTCDate(target.getUTCDate() + Number(inDays[1]));
      parsed.date = target.toISOString().slice(0, 10);
    }
  }

  const after = /\b(?:after|from|at|after)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (after?.[1]) {
    parsed.afterTime = normaliseClock(Number(after[1]), after[2], after[3]);
  }
  const before = /\b(?:before|until|till|til)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (before?.[1]) {
    parsed.beforeTime = normaliseClock(Number(before[1]), before[2], before[3]);
  }
  if (/\b(tonight|now|open now|open today)\b/.test(text)) {
    parsed.openNow = true;
    if (!parsed.date) parsed.date = now.toISOString().slice(0, 10);
  }

  const money = /(?:under|below|less than|up to|max|within|£|\$)\s*(\d{2,4})/.exec(text);
  if (money?.[1]) {
    parsed.maxPriceMinor = MONEY_TO_MINOR[money[1]] ?? Number(money[1]) * 100;
  }

  const near = /\b(?:near|around|in|at|close to)\s+([a-z][a-z\s'-]{2,40}?)(?=\s*(?:$|tomorrow|today|tonight|under|before|after|for|with|and|,))/.exec(
    text,
  );
  if (near?.[1]) parsed.near = near[1].trim();

  if (/\b(male|men|man|barber|gentleman)\b/.test(text)) parsed.providerGender = "male";
  if (/\b(female|woman|women|lady|ladies)\b/.test(text)) parsed.providerGender = "female";

  if (/\b(instant book|instant-book|book instantly|now available)\b/.test(text)) {
    parsed.instantBook = true;
  }
  if (/\b(mobile|comes to me|at home|home service|doorstep)\b/.test(text)) {
    parsed.instantBook = parsed.instantBook ?? false;
  }

  const serviceMatch = /\b(?:for|a|need|want|book|haircut|cut|trim|colour|fade|beard|manicure|pedicure|lash|brow|wax)\s+([a-z][a-z\s-]{2,30})/.exec(
    text,
  );
  if (serviceMatch?.[1]) {
    const candidate = serviceMatch[1]
      .split(/\s(?:under|before|after|near|tomorrow|today|tonight|for|with|and)\s/)[0]
      ?.trim();
    if (candidate) parsed.service = candidate;
  }

  return parsed;
}

function normaliseClock(hour: number, minute: string | undefined, meridiem: string | undefined): string {
  let h = hour;
  const m = minute ?? "00";
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  return `${String(Math.min(23, h)).padStart(2, "0")}:${m}`;
}

export async function recordSearchActivity(
  userId: string | null,
  type: "search" | "smart_search" | "view",
  input: {
    query?: string | null;
    parsed?: unknown;
    targetType?: string | null;
    targetId?: string | null;
  },
): Promise<AppDocument | null> {
  if (!userId) return null;
  const at = isoNow();
  const doc: AppDocument = {
    _id: generateId("act"),
    userId,
    type,
    query: input.query ?? null,
    parsed: input.parsed ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    at,
    expiresAt: new Date(Date.now() + 90 * 24 * 3_600_000).toISOString(),
    createdAt: at,
    updatedAt: at,
  };
  await getCollection(Collections.userActivities).insertOne(doc);
  return doc;
}

/** Side-by-side price / distance / next-slot comparison. */
export async function compareBusinesses(
  serviceId: string,
  businessIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const service = await getCollection<ServiceDoc>(Collections.services).findOne({ _id: serviceId });
  if (!service) throw ApiError.notFound("Service not found");
  const businesses = await getCollection<BusinessDoc>(Collections.businesses)
    .find({ _id: { $in: businessIds } })
    .toArray();
  const locations = await getCollection<LocationDoc>(Collections.locations)
    .find({ businessId: { $in: businessIds } })
    .toArray();
  const reviews = await getCollection<ReviewDoc>(Collections.reviews)
    .find({ serviceId, status: "published" })
    .toArray();

  return Promise.all(businesses.map(async (business) => {
    const businessReviews = reviews.filter((review) => review.businessId === business._id);
    return {
      businessId: business._id,
      name: business.name,
      slug: business.slug,
      logoUrl: business.logoUrl ?? null,
      service: {
        serviceId: service._id,
        name: service.name,
        priceMinor: service.priceMinor,
        durationMin: service.durationMin,
        currency: service.currency,
      },
      locations: locations
        .filter((location) => location.businessId === business._id)
        .map((location) => ({
          locationId: location._id,
          name: location.name,
          address: location.address,
          coordinates: readCoordinates(location.geo),
        })),
      rating: business.ratingSummary ?? { average: 0, count: 0 },
      serviceRating: businessReviews.length,
      instantBook: (service.instantBook ?? false) || (business.instantBook ?? false),
      nextAvailableSlot: await nextSlotFor(business._id, [service._id]),
      depositRule: service.depositRule ?? null,
    };
  }));
}
