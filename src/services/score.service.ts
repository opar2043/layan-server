import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { isoNow, addDays } from "../shared/utils";
import type {
  BookingDoc,
  BusinessDoc,
  BusinessScoreDoc,
  CustomerDoc,
  ReviewDoc,
  ServiceDoc,
} from "../types/domain";
import { BookingStatus } from "../types/enums";

interface Component {
  value: number;
  weight: number;
}

/** The weighting is fixed and published so a business can see exactly what moves its score. */
export const SCORE_WEIGHTS = {
  profileCompleteness: 15,
  reviews: 20,
  responseRate: 15,
  cancellationRate: 10,
  repeatCustomers: 15,
  availability: 15,
  portfolioActivity: 10,
} as const;

export type ScoreComponentKey = keyof typeof SCORE_WEIGHTS;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function profileCompleteness(business: BusinessDoc): number {
  const checks: Array<[boolean, number]> = [
    [Boolean(business.description && business.description.length > 40), 20],
    [Boolean(business.logoUrl), 15],
    [Boolean(business.coverUrl), 15],
    [Array.isArray(business.amenities) && business.amenities.length >= 3, 10],
    [Array.isArray(business.qualifications) && business.qualifications.length > 0, 10],
    [Array.isArray(business.faqs) && business.faqs.length > 0, 10],
    [Boolean(business.contact?.phone), 10],
    [Array.isArray(business.social) && Object.values(business.social).some(Boolean), 10],
  ];
  return clamp(checks.reduce((sum, [ok, weight]) => sum + (ok ? weight : 0), 0));
}

function reviewScore(reviews: ReviewDoc[]): number {
  if (reviews.length === 0) return 0;
  const average = reviews.reduce((sum, review) => sum + (review.ratings.overall ?? 0), 0) / reviews.length;
  // 4.0 average with volume is a full mark; volume is worth up to 30% of the score.
  const quality = ((average - 3) / 2) * 70;
  const volume = Math.min(30, reviews.length * 1.5);
  return clamp(quality + volume);
}

/** Share of customer messages that the business answered. */
async function responseRate(businessId: string): Promise<number> {
  const conversations = await getCollection(Collections.conversations)
    .find({ businessId })
    .toArray();
  if (conversations.length === 0) return 50; // neutral when there is no data
  const messages = await getCollection(Collections.messages)
    .find({ conversationId: { $in: conversations.map((row) => row._id) } })
    .toArray();
  if (messages.length === 0) return 50;

  let answered = 0;
  for (const conversation of conversations) {
    const thread = messages
      .filter((message) => message.conversationId === conversation._id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const lastCustomer = [...thread]
      .reverse()
      .find((message) => message.senderType === "customer");
    if (!lastCustomer) continue;
    const businessReplied = thread.some(
      (message) =>
        message.senderType === "business" &&
        String(message.createdAt) > String(lastCustomer.createdAt),
    );
    if (businessReplied) answered += 1;
  }
  return clamp((answered / conversations.length) * 100);
}

function cancellationScore(bookings: BookingDoc[]): number {
  if (bookings.length === 0) return 70; // neutral baseline
  const bad = bookings.filter(
    (booking) =>
      booking.status === BookingStatus.LATE_CANCEL || booking.status === BookingStatus.NO_SHOW,
  ).length;
  const rate = bad / bookings.length;
  return clamp(100 - rate * 200);
}

function repeatCustomerScore(bookings: BookingDoc[]): number {
  if (bookings.length === 0) return 0;
  const byCustomer = new Map<string, number>();
  for (const booking of bookings) {
    byCustomer.set(booking.customerUserId, (byCustomer.get(booking.customerUserId) ?? 0) + 1);
  }
  const repeats = [...byCustomer.values()].filter((count) => count > 1).length;
  return clamp((repeats / byCustomer.size) * 100);
}

async function availabilityScore(businessId: string): Promise<number> {
  const services = await getCollection<ServiceDoc>(Collections.services)
    .find({ businessId, isActive: true })
    .toArray();
  if (services.length === 0) return 0;
  const withPricing = services.filter((service) => service.priceMinor > 0).length;
  const withLeadTime = services.filter((service) => (service.leadTimeMinutes ?? 0) > 0).length;
  const withCycle = services.filter((service) => service.rebookCycleDays !== null).length;
  return clamp(
    (withPricing / services.length) * 40 +
      (withLeadTime / services.length) * 30 +
      (withCycle / services.length) * 30,
  );
}

async function portfolioScore(businessId: string): Promise<number> {
  const items = await getCollection(Collections.portfolioItems)
    .find({ businessId, status: "published" })
    .toArray();
  if (items.length === 0) return 0;
  const recent = items.filter(
    (item) => Date.now() - new Date(String(item.createdAt)).getTime() < 90 * 24 * 3_600_000,
  ).length;
  const discovery = items.filter((item) => item.publishToDiscovery === true).length;
  return clamp(
    Math.min(60, items.length * 6) + Math.min(20, recent * 2) + Math.min(20, discovery * 2),
  );
}

export interface ScoreResult {
  businessId: string;
  period: string;
  score: number;
  components: Record<ScoreComponentKey, Component>;
  recommendations: Array<{ action: string; estimatedGain: number }>;
}

/**
 * Weighted 0–100 Business Score. Runs nightly (and on demand by an admin) and is
 * the only writer of `businessScores` and `businesses.businessScore`.
 */
export async function computeBusinessScore(
  businessId: string,
  now = new Date(),
): Promise<ScoreResult> {
  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({
    _id: businessId,
  });
  if (!business) throw new Error(`Business ${businessId} not found`);

  const ninetyDaysAgo = addDays(now, -90).toISOString();
  const [bookings, reviews, customers] = await Promise.all([
    getCollection<BookingDoc>(Collections.bookings)
      .find({ businessId, startAt: { $gte: ninetyDaysAgo } })
      .toArray(),
    getCollection<ReviewDoc>(Collections.reviews)
      .find({ businessId, status: "published" })
      .toArray(),
    getCollection<CustomerDoc>(Collections.customers).find({ businessId }).toArray(),
  ]);

  const components: Record<ScoreComponentKey, Component> = {
    profileCompleteness: { value: profileCompleteness(business), weight: SCORE_WEIGHTS.profileCompleteness },
    reviews: { value: reviewScore(reviews), weight: SCORE_WEIGHTS.reviews },
    responseRate: { value: await responseRate(businessId), weight: SCORE_WEIGHTS.responseRate },
    cancellationRate: { value: cancellationScore(bookings), weight: SCORE_WEIGHTS.cancellationRate },
    repeatCustomers: { value: repeatCustomerScore(bookings), weight: SCORE_WEIGHTS.repeatCustomers },
    availability: { value: await availabilityScore(businessId), weight: SCORE_WEIGHTS.availability },
    portfolioActivity: { value: await portfolioScore(businessId), weight: SCORE_WEIGHTS.portfolioActivity },
  };

  const totalWeight = Object.values(components).reduce((sum, c) => sum + c.weight, 0);
  const score = clamp(
    Object.values(components).reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight,
  );

  return {
    businessId,
    period: now.toISOString().slice(0, 7),
    score,
    components,
    recommendations: buildRecommendations(components, customers.length),
  };
}

/** 1–3 concrete actions, ranked by the points they would actually recover. */
function buildRecommendations(
  components: Record<ScoreComponentKey, Component>,
  customerCount: number,
): Array<{ action: string; estimatedGain: number }> {
  const suggestions: Array<{ action: string; estimatedGain: number }> = [];

  const gain = (key: ScoreComponentKey, target: number): number => {
    const current = components[key].value;
    if (current >= target) return 0;
    const valuePoints = ((target - current) * components[key].weight) / 100;
    return Math.round(valuePoints * 10) / 10;
  };

  const portfolio = gain("portfolioActivity", 85);
  if (portfolio > 0) suggestions.push({ action: "Publish 3 more recent portfolio items", estimatedGain: portfolio });

  const reviews = gain("reviews", 80);
  if (reviews > 0) suggestions.push({ action: "Invite your last 10 attended customers to leave a review", estimatedGain: reviews });

  const response = gain("responseRate", 90);
  if (response > 0) suggestions.push({ action: "Enable auto-replies so no customer message waits more than an hour", estimatedGain: response });

  const profile = gain("profileCompleteness", 95);
  if (profile > 0) suggestions.push({ action: "Complete your profile: add qualifications, amenities and FAQs", estimatedGain: profile });

  const availability = gain("availability", 85);
  if (availability > 0) suggestions.push({ action: "Set a rebook cycle and lead time on every service", estimatedGain: availability });

  const cancellations = gain("cancellationRate", 85);
  if (cancellations > 0) suggestions.push({ action: "Require a deposit on peak slots to reduce late cancellations", estimatedGain: cancellations });

  if (customerCount > 0 && components.repeatCustomers.value < 60) {
    suggestions.push({ action: "Run a rebooking campaign targeting overdue customers", estimatedGain: 3 });
  }

  return suggestions.slice(0, 3);
}

export async function persistBusinessScore(result: ScoreResult): Promise<BusinessScoreDoc> {
  const at = isoNow();
  const existing = await getCollection<BusinessScoreDoc>(Collections.businessScores).findOne({
    businessId: result.businessId,
    period: result.period,
  });

  const doc: BusinessScoreDoc = {
    _id: existing?._id ?? `bsc-${result.businessId}-${result.period}`,
    businessId: result.businessId,
    period: result.period,
    score: result.score,
    components: result.components,
    recommendations: result.recommendations,
    computedAt: at,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };

  await getCollection<BusinessScoreDoc>(Collections.businessScores).updateOne(
    { _id: doc._id },
    { $set: doc },
    { upsert: true },
  );

  await getCollection(Collections.businesses).updateOne(
    { _id: result.businessId },
    { $set: { businessScore: result.score, updatedAt: at } },
  );

  return doc;
}
