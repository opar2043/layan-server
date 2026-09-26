import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { config } from "../shared/config";
import { ApiError } from "../shared/errors";
import { addDays, dateKeyOf, daysBetween, isoNow } from "../shared/utils";
import type { BookingDoc, CustomerDoc, ServiceDoc } from "../types/domain";
import { BookingStatus } from "../types/enums";
import { sendNotification } from "./notification.service";

export interface InsightUpdate {
  customerId: string;
  businessId: string;
  avgRebookIntervalDays: number | null;
  nextExpectedVisit: string | null;
  overdueDays: number;
  isOverdue: boolean;
  suggestedAction: string | null;
  segments: string[];
}

/**
 * Nightly recompute of `Customer.insights`.
 *
 * `insights` is server-owned: it is derived from booking history here and is never
 * accepted from a client body (the field is stripped on every write path).
 */
export async function recomputeCustomerInsights(
  businessId?: string,
  now = new Date(),
): Promise<{ updated: number; notified: number }> {
  const filter: Record<string, unknown> = {};
  if (businessId) filter.businessId = businessId;

  const customers = await getCollection<CustomerDoc>(Collections.customers)
    .find({ ...filter, isBlocked: { $ne: true } })
    .toArray();
  if (customers.length === 0) return { updated: 0, notified: 0 };

  const bookings = await getCollection<BookingDoc>(Collections.bookings)
    .find({
      ...(businessId ? { businessId } : {}),
      status: BookingStatus.ATTENDED,
    })
    .toArray();

  const byCustomer = new Map<string, BookingDoc[]>();
  for (const booking of bookings) {
    const list = byCustomer.get(booking.customerUserId) ?? [];
    list.push(booking);
    byCustomer.set(booking.customerUserId, list);
  }

  const services = await getCollection<ServiceDoc>(Collections.services).find({}).toArray();
  const serviceById = new Map(services.map((service) => [service._id, service]));

  let updated = 0;
  let notified = 0;

  for (const customer of customers) {
    const history = (byCustomer.get(customer.userId) ?? [])
      .slice()
      .sort((a, b) => a.startAt.localeCompare(b.startAt));

    const insight = deriveInsight(history, serviceById, customer, now);
    await getCollection<CustomerDoc>(Collections.customers).updateOne(
      { _id: customer._id },
      { $set: { insights: insight, updatedAt: isoNow() } },
    );
    updated += 1;

    const wasOverdue = customer.insights?.isOverdue === true;
    if (insight.isOverdue && !wasOverdue) {
      const favourites = customer.favouriteServiceId
        ? serviceById.get(customer.favouriteServiceId)?.name ?? "your usual service"
        : "your usual service";
      const staffName = customer.favouriteStaffId
        ? (await getCollection(Collections.staff).findOne({ _id: customer.favouriteStaffId }))
            ?.displayName
        : null;

      await sendNotification({
        userId: customer.userId,
        type: "rebooking_due",
        title: "Time for a refresh?",
        body: staffName
          ? `${favourites} with ${staffName} — see the next free slots.`
          : `${favourites} — see the next free slots.`,
        data: {
          customerId: customer._id,
          businessId: customer.businessId,
          overdueDays: insight.overdueDays,
        },
      });
      notified += 1;
    }
  }

  return { updated, notified };
}

function deriveInsight(
  history: BookingDoc[],
  serviceById: Map<string, ServiceDoc>,
  customer: CustomerDoc,
  now: Date,
): CustomerDoc["insights"] {
  const segments = new Set<string>();

  if (history.length === 0) {
    return {
      avgRebookIntervalDays: null,
      nextExpectedVisit: null,
      overdueDays: 0,
      isOverdue: false,
      suggestedAction: null,
      segments: ["new"],
    };
  }

  // Interval per service, where the customer has visited at least twice.
  const perService = new Map<string, number[]>();
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (!previous || !current) continue;
    const serviceId = current.items[0]?.serviceId ?? "";
    const gap = daysBetween(new Date(previous.startAt), new Date(current.startAt));
    if (gap <= 0) continue;
    const list = perService.get(serviceId) ?? [];
    list.push(gap);
    perService.set(serviceId, list);
  }

  const intervals: number[] = [];
  for (const list of perService.values()) intervals.push(...list);
  const avgRebookIntervalDays =
    intervals.length === 0
      ? null
      : Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length);

  // Fall back to the service's configured rebook cycle when history is thin.
  const favouriteService = customer.favouriteServiceId
    ? serviceById.get(customer.favouriteServiceId)
    : undefined;
  const configuredCycle = favouriteService?.rebookCycleDays
    ? (favouriteService.rebookCycleDays.min + favouriteService.rebookCycleDays.max) / 2
    : null;
  const effectiveInterval = avgRebookIntervalDays ?? configuredCycle;

  const lastVisit = history[history.length - 1];
  const lastVisitAt = lastVisit ? new Date(lastVisit.startAt) : null;

  let overdueDays = 0;
  let nextExpectedVisit: string | null = null;
  let isOverdue = false;

  if (lastVisitAt && effectiveInterval) {
    nextExpectedVisit = dateKeyOf(addDays(lastVisitAt, effectiveInterval));
    const dueBy = new Date(`${nextExpectedVisit}T23:59:59.000Z`);
    overdueDays = Math.max(0, daysBetween(dueBy, now));
    isOverdue = overdueDays >= config.rebooking.graceDays;
  }

  const hasUpcoming = hasUpcomingBooking(customer);
  if (hasUpcoming) segments.add("has_upcoming");
  if (history.length === 1) segments.add("new");
  if (history.length > 1) segments.add("returning");
  if ((customer.stats.lifetimeSpendMinor ?? 0) > 20000) segments.add("vip");
  if (customer.stats.noShows > 0 || customer.stats.cancellations >= 2) segments.add("at_risk");
  if (isOverdue) segments.add("due_to_rebook");

  let suggestedAction: string | null = null;
  if (isOverdue) suggestedAction = "send_rebooking_offer";
  else if (history.length === 1) suggestedAction = "send_second_visit_offer";
  else if (hasUpcoming) suggestedAction = "none";

  return {
    avgRebookIntervalDays,
    nextExpectedVisit,
    overdueDays,
    isOverdue,
    suggestedAction,
    segments: [...segments],
  };
}

/** Reads the mirrored `stats.upcomingBookingId`, avoiding an extra query per customer. */
function hasUpcomingBooking(customer: CustomerDoc): boolean {
  return typeof customer.stats?.upcomingBookingId === "string" && customer.stats.upcomingBookingId.length > 0;
}

export interface RebookingPrompt {
  id: string;
  customerId: string;
  businessId: string;
  serviceId: string | null;
  staffId: string | null;
  reason: string;
  overdueDays: number;
  nextExpectedVisit: string | null;
  headline: string;
}

/**
 * Server-computed one-tap rebooking prompts. The customer sees these; the raw
 * `insights` block stays internal to the business.
 */
export async function rebookingPromptsForUser(
  userId: string,
): Promise<RebookingPrompt[]> {
  const customers = await getCollection<CustomerDoc>(Collections.customers)
    .find({ userId, isBlocked: { $ne: true } })
    .toArray();
  if (customers.length === 0) return [];

  const businessIds = [...new Set(customers.map((customer) => customer.businessId))];
  const businesses = await getCollection(Collections.businesses)
    .find({ _id: { $in: businessIds } })
    .toArray();
  const nameById = new Map(businesses.map((business) => [business._id, business.name]));

  const prompts: RebookingPrompt[] = [];
  for (const customer of customers) {
    const insights = customer.insights;
    if (!insights?.isOverdue) continue;
    const service = customer.favouriteServiceId
      ? await getCollection(Collections.services).findOne({ _id: customer.favouriteServiceId })
      : null;
    const businessName = nameById.get(customer.businessId) ?? "your salon";
    prompts.push({
      id: `rb-${customer._id}`,
      customerId: customer._id,
      businessId: customer.businessId,
      serviceId: customer.favouriteServiceId ?? null,
      staffId: customer.favouriteStaffId ?? null,
      reason: insights.suggestedAction ?? "send_rebooking_offer",
      overdueDays: insights.overdueDays,
      nextExpectedVisit: insights.nextExpectedVisit,
      headline:
        insights.overdueDays > 0
          ? `You are ${insights.overdueDays} day(s) overdue at ${businessName}`
          : `Time for a visit at ${businessName}`,
    });
    if (service && prompts.length > 0) {
      prompts[prompts.length - 1]!.headline = `${service.name} is due — book at ${businessName}`;
    }
  }

  return prompts;
}

export async function acceptRebookingPrompt(
  userId: string,
  promptId: string,
): Promise<{ businessId: string; serviceId: string | null; staffId: string | null }> {
  const customerId = promptId.startsWith("rb-") ? promptId.slice(3) : promptId;
  const customer = await getCollection<CustomerDoc>(Collections.customers).findOne({
    _id: customerId,
    userId,
  });
  if (!customer) throw ApiError.notFound("Rebooking prompt not found");
  if (!customer.insights?.isOverdue) {
    throw ApiError.unprocessable("This prompt is no longer active");
  }

  await getCollection<CustomerDoc>(Collections.customers).updateOne(
    { _id: customer._id },
    { $set: { updatedAt: isoNow() } },
  );

  return {
    businessId: customer.businessId,
    serviceId: customer.favouriteServiceId ?? null,
    staffId: customer.favouriteStaffId ?? null,
  };
}
