import {
  MongoClient,
  type Collection,
  type Db,
  type Document,
  type Filter,
  type IndexDescription,
  type UpdateFilter,
} from "mongodb";
import { Collections } from "./collections";

let client: MongoClient | null = null;
let db: Db | null = null;
let connecting: Promise<void> | null = null;

/** All documents use string `_id` values (matching `data.json`), never ObjectId. */
export interface AppDocument {
  _id: string;
  [key: string]: unknown;
}

export function connectDb(uri: string, name: string): Promise<void> {
  if (db) return Promise.resolve();
  if (connecting) return connecting;

  connecting = (async () => {
    const next = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    await next.connect();
    client = next;
    db = client.db(name);
  })().finally(() => {
    connecting = null;
  });

  return connecting;
}

export function isDbConnected(): boolean {
  return db !== null;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not connected");
  return db;
}

export function getCollection<T extends Document = AppDocument>(
  name: string,
): Collection<T> {
  return getDb().collection<T>(name);
}

/**
 * Typed casts for building filters and updates dynamically.
 *
 * Domain interfaces deliberately carry no index signature (that keeps field typos
 * out of the database and keeps the driver's `Filter<T>` precise), so a filter
 * assembled from runtime input needs one narrow cast. The type parameter still
 * pins the result to the collection it is used against.
 */
export function asFilter<T>(value: Record<string, unknown>): Filter<T> {
  return value as Filter<T>;
}

export function asUpdate<T>(value: Record<string, unknown>): UpdateFilter<T> {
  return value as UpdateFilter<T>;
}

/**
 * Double-booking prevention is a DB-level constraint, not UI logic.
 *
 * `slotKey` is `"{staffId}::{startAt ISO}"` and is only set while the booking
 * actually holds the slot (`slotActive: true`). A unique partial index on
 * `slotKey` therefore allows any number of released/cancelled rows to coexist
 * while making two concurrent claims on the same slot impossible — the loser's
 * `insertOne` throws a duplicate-key error, which the booking service maps to 409.
 */
export const BOOKING_INDEXES: IndexDescription[] = [
  {
    key: { slotKey: 1 },
    name: "uniq_active_staff_slot",
    unique: true,
    partialFilterExpression: { slotActive: true },
  },
  {
    key: { resourceId: 1, startAt: 1 },
    name: "uniq_active_resource_slot",
    unique: true,
    partialFilterExpression: { slotActive: true, resourceId: { $type: "string" } },
  },
  { key: { businessId: 1, startAt: 1 }, name: "business_calendar" },
  { key: { customerUserId: 1, startAt: -1 }, name: "customer_calendar" },
  { key: { customerId: 1, startAt: -1 }, name: "customer_profile_calendar" },
  { key: { staffId: 1, startAt: 1 }, name: "staff_calendar" },
];

const COMMON_INDEXES: Record<string, IndexDescription[]> = {
  [Collections.users]: [
    { key: { email: 1 }, name: "uniq_email", unique: true },
    { key: { role: 1, status: 1 }, name: "role_status" },
  ],
  [Collections.verificationRequests]: [
    { key: { status: 1, submittedAt: -1 }, name: "status_submitted" },
  ],
  [Collections.businesses]: [
    { key: { slug: 1 }, name: "uniq_slug", unique: true },
    { key: { ownerId: 1 }, name: "owner" },
    { key: { status: 1, businessScore: -1 }, name: "status_score" },
  ],
  [Collections.locations]: [{ key: { businessId: 1, isPrimary: -1 }, name: "business_primary" }],
  [Collections.staff]: [
    { key: { userId: 1 }, name: "user", unique: true },
    { key: { businessId: 1, status: 1 }, name: "business_status" },
  ],
  [Collections.categories]: [{ key: { slug: 1 }, name: "uniq_slug", unique: true }],
  [Collections.services]: [{ key: { businessId: 1, isActive: 1 }, name: "business_active" }],
  [Collections.timeOffs]: [
    { key: { staffId: 1, startAt: 1, endAt: 1 }, name: "staff_window" },
  ],
  [Collections.waitlists]: [
    { key: { businessId: 1, status: 1, createdAt: -1 }, name: "business_status" },
  ],
  [Collections.instantSlots]: [
    { key: { businessId: 1, status: 1, startAt: 1 }, name: "business_status_start" },
  ],
  [Collections.orders]: [{ key: { businessId: 1, status: 1, createdAt: -1 }, name: "biz_status" }],
  [Collections.payments]: [
    { key: { businessId: 1, paidAt: -1 }, name: "business_paid" },
    { key: { customerUserId: 1, createdAt: -1 }, name: "customer_payments" },
  ],
  [Collections.payouts]: [{ key: { businessId: 1, periodStart: -1 }, name: "business_period" }],
  [Collections.wallets]: [{ key: { userId: 1 }, name: "uniq_user", unique: true }],
  [Collections.walletTransactions]: [{ key: { userId: 1, createdAt: -1 }, name: "user_time" }],
  [Collections.giftCards]: [{ key: { code: 1 }, name: "uniq_code", unique: true }],
  [Collections.customers]: [
    { key: { businessId: 1, userId: 1 }, name: "uniq_business_user", unique: true },
    { key: { businessId: 1, "insights.isOverdue": 1 }, name: "overdue_lookup" },
  ],
  [Collections.consultationResponses]: [
    { key: { bookingId: 1, formId: 1 }, name: "booking_form" },
  ],
  [Collections.loyaltyTransactions]: [
    { key: { userId: 1, createdAt: -1 }, name: "user_time" },
  ],
  [Collections.referrals]: [
    { key: { code: 1 }, name: "code" },
    { key: { referrerUserId: 1 }, name: "referrer" },
  ],
  [Collections.reviews]: [
    { key: { bookingId: 1 }, name: "uniq_booking", unique: true },
    { key: { businessId: 1, status: 1, createdAt: -1 }, name: "business_status" },
    { key: { staffId: 1, status: 1, createdAt: -1 }, name: "staff_status" },
  ],
  [Collections.favourites]: [
    { key: { userId: 1, targetType: 1, targetId: 1 }, name: "uniq_target", unique: true },
  ],
  [Collections.conversations]: [
    { key: { bookingId: 1 }, name: "booking" },
    { key: { businessId: 1, updatedAt: -1 }, name: "business_recent" },
  ],
  [Collections.messages]: [{ key: { conversationId: 1, createdAt: 1 }, name: "conversation_time" }],
  [Collections.notifications]: [{ key: { userId: 1, createdAt: -1 }, name: "user_time" }],
  [Collections.products]: [
    { key: { businessId: 1, sku: 1 }, name: "uniq_business_sku", unique: true },
  ],
  [Collections.businessScores]: [
    { key: { businessId: 1, period: 1 }, name: "uniq_business_period", unique: true },
  ],
  [Collections.badgeAwards]: [
    { key: { businessId: 1, badgeKey: 1, status: 1 }, name: "business_badge_status" },
  ],
  [Collections.fraudFlags]: [
    { key: { status: 1, createdAt: -1 }, name: "status_time" },
    { key: { targetType: 1, targetId: 1 }, name: "target" },
  ],
  [Collections.disputes]: [{ key: { status: 1, createdAt: -1 }, name: "status_time" }],
  [Collections.userActivities]: [{ key: { userId: 1, at: -1 }, name: "user_time" }],
  [Collections.adminActionLogs]: [{ key: { adminId: 1, at: -1 }, name: "admin_time" }],
  [Collections.subscriptions]: [{ key: { businessId: 1 }, name: "uniq_business", unique: true }],
  [Collections.importJobs]: [{ key: { businessId: 1, createdAt: -1 }, name: "business_time" }],
};

/**
 * Idempotent index bootstrap. Called once on boot. Existing indexes with the same
 * name but a conflicting definition are dropped and rebuilt so the double-booking
 * guarantee is never silently skipped.
 */
export async function ensureIndexes(): Promise<void> {
  const database = getDb();

  for (const [name, indexes] of Object.entries(COMMON_INDEXES)) {
    await reconcileIndexes(database.collection(name), indexes);
  }
  await reconcileIndexes(database.collection(Collections.bookings), BOOKING_INDEXES);
}

async function reconcileIndexes(
  collection: Collection,
  desired: readonly IndexDescription[],
): Promise<void> {
  let existing: IndexDescription[] = [];
  try {
    existing = await collection.indexes();
  } catch {
    return;
  }
  const byName = new Map(existing.map((index) => [index.name, index]));

  for (const index of desired) {
    const current = byName.get(index.name);
    if (current && sameIndexSpec(current, index)) continue;
    if (current) {
      if (current.name) await collection.dropIndex(current.name).catch(() => undefined);
    }
    await collection.createIndex(index.key, index).catch((error: unknown) => {
      // A pre-existing duplicate key set would block the unique guard. Surface it
      // loudly rather than silently running without double-booking protection.
      console.error(`[db] failed to create index ${index.name} on ${collection.collectionName}`, error);
    });
  }
}

function sameIndexSpec(a: IndexDescription, b: IndexDescription): boolean {
  return (
    JSON.stringify(normaliseSpec(a.key)) === JSON.stringify(normaliseSpec(b.key)) &&
    Boolean(a.unique) === Boolean(b.unique) &&
    JSON.stringify(a.partialFilterExpression ?? null) ===
      JSON.stringify(b.partialFilterExpression ?? null)
  );
}

function normaliseSpec(spec: unknown): unknown {
  return JSON.stringify(spec, Object.keys(spec as Record<string, unknown>).sort());
}

export async function disconnectDb(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
