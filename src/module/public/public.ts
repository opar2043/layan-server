import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { getCollection } from "../../shared/db";
import { queryInt, readCoordinates } from "../../shared/utils";
import type { Paginated } from "../../shared/response";
import type { BusinessDoc, CategoryDoc, ReviewDoc } from "../../types/domain";
import { parseNaturalLanguageQuery, search } from "../../services/search.service";

/**
 * Marketplace logic for anonymous visitors.
 *
 * Nothing in here may expose a customer record, a financial figure, or an
 * internal flag. The shaping functions (`publicBusiness`, and the inline mappers
 * below) are the allow-list: a field has to be named there to be reachable from
 * `/api/public`, so a future schema addition cannot leak by default.
 */

export interface Paging {
  page: number;
  pageSize: number;
}

export interface PublicBusinessSearch extends Paging {
  city?: string;
  q?: string;
}

/** Reads and clamps pagination from a query string. */
export function pagingFrom(query: Record<string, unknown>, defaultPageSize = 25): Paging {
  return {
    page: queryInt(query, "page", 1, 1, 10_000),
    pageSize: queryInt(query, "pageSize", defaultPageSize, 1, 100),
  };
}

export function paginate<T>(data: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { data, page, pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize) };
}

/** Escapes user input before it is used as a case-insensitive regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips a business down to what a stranger may see. */
export function publicBusiness(business: BusinessDoc): Record<string, unknown> {
  return {
    _id: business._id,
    name: business.name,
    slug: business.slug,
    description: business.description ?? null,
    categoryIds: business.categoryIds ?? [],
    logoUrl: business.logoUrl ?? null,
    coverUrl: business.coverUrl ?? null,
    amenities: business.amenities ?? [],
    instantBook: business.instantBook === true,
    isMobileService: business.isMobileService === true,
    ratingSummary: business.ratingSummary ?? { average: 0, count: 0 },
    businessScore: business.businessScore ?? null,
    badges: business.badges ?? [],
    verification: business.verification ?? { identityVerified: false, businessVerified: false },
    currency: business.currency,
    timezone: business.timezone,
  };
}

export async function listCategories(): Promise<CategoryDoc[]> {
  return getCollection<CategoryDoc>(Collections.categories)
    .find({ isActive: true })
    .sort({ sortOrder: 1 })
    .toArray();
}

export async function listBusinesses(
  options: PublicBusinessSearch,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = { status: "active" };
  if (options.city) filter.city = options.city;
  if (options.q) filter.name = { $regex: escapeRegex(options.q), $options: "i" };

  const collection = getCollection<BusinessDoc>(Collections.businesses);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((options.page - 1) * options.pageSize)
      .limit(options.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs.map(publicBusiness), total, options.page, options.pageSize);
}

/**
 * Resolves a business by readable slug or by id, so a share link can use the
 * pretty form while internal callers keep using the id. A business that is not
 * `active` is treated as absent rather than forbidden — its existence is not
 * something a stranger should learn.
 */
async function resolveActiveBusiness(key: string): Promise<BusinessDoc> {
  const businesses = getCollection<BusinessDoc>(Collections.businesses);
  const business =
    (await businesses.findOne({ slug: key })) ?? (await businesses.findOne({ _id: key }));
  if (!business || business.status !== "active") throw ApiError.notFound("Business not found");
  return business;
}

export interface PublicBusinessProfile {
  business: Record<string, unknown>;
  faqs: unknown[];
  cancellationPolicy: unknown;
  locations: Array<Record<string, unknown>>;
  staff: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
}

/** Everything a stranger needs to render one business's landing page. */
export async function getBusinessProfile(key: string): Promise<PublicBusinessProfile> {
  const business = await resolveActiveBusiness(key);

  const [locations, staffDocs, services, reviews] = await Promise.all([
    getCollection(Collections.locations).find({ businessId: business._id, status: "active" }).toArray(),
    getCollection(Collections.staff)
      .find({ businessId: business._id, status: "active", bookable: true })
      .toArray(),
    getCollection(Collections.services).find({ businessId: business._id, isActive: true }).toArray(),
    getCollection<ReviewDoc>(Collections.reviews)
      .find({ businessId: business._id, status: "published" })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray(),
  ]);

  return {
    business: publicBusiness(business),
    faqs: business.faqs ?? [],
    cancellationPolicy: business.cancellationPolicy,
    locations: locations.map((row) => {
      const location = row as Record<string, unknown>;
      return {
        _id: location._id,
        name: location.name,
        address: location.address,
        coordinates: readCoordinates(location.geo),
        phone: location.phone ?? null,
        timezone: location.timezone,
        openingHours: location.openingHours ?? null,
        amenities: location.amenities ?? [],
      };
    }),
    staff: staffDocs.map((row) => {
      const staff = row as Record<string, unknown>;
      return {
        _id: staff._id,
        displayName: staff.displayName,
        title: staff.title ?? null,
        role: staff.role,
        avatarUrl: staff.avatarUrl ?? null,
        bio: staff.bio ?? null,
        ratingSummary: staff.ratingSummary ?? { average: 0, count: 0 },
      };
    }),
    services: services.map((row) => {
      const service = row as Record<string, unknown>;
      return {
        _id: service._id,
        name: service.name,
        description: service.description ?? null,
        categoryId: service.categoryId ?? null,
        durationMin: service.durationMin,
        priceMinor: service.priceMinor,
        currency: service.currency,
        instantBook: service.instantBook === true,
        depositRule: service.depositRule ?? null,
      };
    }),
    reviews: reviews.map((review) => ({
      _id: review._id,
      staffId: review.staffId,
      serviceId: review.serviceId,
      ratings: review.ratings,
      comment: review.comment ?? "",
      photos: review.photos ?? [],
      isVerifiedBooking: review.isVerifiedBooking,
      businessReply: review.businessReply ?? null,
      createdAt: review.createdAt,
    })),
  };
}

export interface PublicSearchParams {
  q?: string;
  categoryId?: string;
  serviceId?: string;
  city?: string;
  postcode?: string;
  lat?: number;
  lng?: number;
  limit: number;
  page: number;
}

export async function runSearch(params: PublicSearchParams): Promise<unknown> {
  return search(params);
}

export async function listServices(
  query: Record<string, unknown>,
): Promise<Paginated<Record<string, unknown>>> {
  const { page, pageSize } = pagingFrom(query);
  const filter: Record<string, unknown> = { isActive: true };
  if (typeof query.categoryId === "string") filter.categoryId = query.categoryId;

  const collection = getCollection(Collections.services);
  const [docs, total] = await Promise.all([
    collection.find(filter).sort({ sortOrder: 1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    collection.countDocuments(filter),
  ]);

  return paginate(
    docs.map((row) => {
      const service = row as Record<string, unknown>;
      return {
        _id: service._id,
        businessId: service.businessId,
        name: service.name,
        categoryId: service.categoryId ?? null,
        durationMin: service.durationMin,
        priceMinor: service.priceMinor,
        currency: service.currency,
        instantBook: service.instantBook === true,
      };
    }),
    total,
    page,
    pageSize,
  );
}

export { parseNaturalLanguageQuery };
