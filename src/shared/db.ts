import { Collection, Db, Document, MongoClient } from "mongodb";

/**
 * MongoDB access via the OFFICIAL NATIVE DRIVER (no ODM).
 *
 * Because there is no Mongoose in this project, schema validation, timestamps,
 * `populate` and index creation are handled explicitly:
 *   - validation  -> shared/validate.ts
 *   - timestamps   -> shared/timestamps.ts
 *   - populate     -> shared/populate.ts
 *   - indexes      -> createIndexes() below, invoked once at boot
 */
let client: MongoClient | null = null;
let db: Db | null = null;

const COLLECTIONS = {
  ADMINS: "admins",
  BUSINESSES: "businesses",
  USERS: "users",
  SERVICES: "services",
  STAFF: "staff",
  BOOKINGS: "bookings",
  WAITLIST_ENTRIES: "waitlistEntries",
  REVIEWS: "reviews",
  WALLETS: "wallets",
  WALLET_TRANSACTIONS: "walletTransactions",
  MESSAGES: "messages",
  PROMOTIONS: "promotions",
  DISPUTES: "disputes",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
export { COLLECTIONS };

/** Opens the connection and pins the active database from DB_NAME. */
export async function connectDB(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set — check your .env file");
  }

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();

  const dbName = process.env.DB_NAME || "layan_db";
  db = client.db(dbName);
  await db.command({ ping: 1 });

  // eslint-disable-next-line no-console
  console.log(`[db] connected to database "${dbName}"`);
  return db;
}

/** Returns the active database. Throws if connectDB() has not run yet. */
export function getDb(): Db {
  if (!db) {
    throw new Error("Database not initialised — connectDB() must run before any query");
  }
  return db;
}

/** Typed-ish handle for a collection. */
export function getCollection<T extends Document = Document>(
  name: CollectionName
): Collection<T> {
  return getDb().collection<T>(name);
}

export async function closeDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

/**
 * Every index the app relies on. The native driver does not create these for us,
 * so they are declared once at boot. Matching the spec's guidance: index anything
 * that gets filtered, joined or used for double-booking overlap checks.
 */
export async function createIndexes(): Promise<void> {
  await Promise.all([
    getCollection(COLLECTIONS.ADMINS).createIndex({ email: 1 }, { unique: true }),

    getCollection(COLLECTIONS.BUSINESSES).createIndex({ email: 1 }, { unique: true }),
    getCollection(COLLECTIONS.BUSINESSES).createIndex(
      { isBusinessVerified: 1, category: 1, "location.city": 1 },
      { name: "public_discovery" }
    ),
    getCollection(COLLECTIONS.BUSINESSES).createIndex({ verificationStatus: 1 }),

    getCollection(COLLECTIONS.USERS).createIndex({ firebaseUid: 1 }, { unique: true }),
    getCollection(COLLECTIONS.USERS).createIndex({ email: 1 }, { unique: true }),
    getCollection(COLLECTIONS.USERS).createIndex({ referralCode: 1 }, { unique: true }),

    getCollection(COLLECTIONS.SERVICES).createIndex(
      { businessId: 1, isActive: 1 },
      { name: "business_services" }
    ),

    getCollection(COLLECTIONS.STAFF).createIndex({ email: 1 }, { unique: true }),
    getCollection(COLLECTIONS.STAFF).createIndex({ businessId: 1, isActive: 1 }),

    // Compound index powering the double-booking overlap query.
    getCollection(COLLECTIONS.BOOKINGS).createIndex(
      { staffId: 1, startTime: 1, endTime: 1, status: 1 },
      { name: "staff_time_overlap" }
    ),
    getCollection(COLLECTIONS.BOOKINGS).createIndex({ customerId: 1, startTime: -1 }),
    getCollection(COLLECTIONS.BOOKINGS).createIndex({ businessId: 1, startTime: -1 }),
    getCollection(COLLECTIONS.BOOKINGS).createIndex({ status: 1 }),

    getCollection(COLLECTIONS.WAITLIST_ENTRIES).createIndex(
      { businessId: 1, status: 1 },
      { name: "business_waitlist" }
    ),
    getCollection(COLLECTIONS.WAITLIST_ENTRIES).createIndex({ customerId: 1 }),

    getCollection(COLLECTIONS.REVIEWS).createIndex({ bookingId: 1 }, { unique: true }),
    getCollection(COLLECTIONS.REVIEWS).createIndex({ businessId: 1, createdAt: -1 }),

    getCollection(COLLECTIONS.WALLETS).createIndex({ customerId: 1 }, { unique: true }),
    getCollection(COLLECTIONS.WALLET_TRANSACTIONS).createIndex(
      { customerId: 1, createdAt: -1 },
      { name: "customer_ledger" }
    ),

    getCollection(COLLECTIONS.MESSAGES).createIndex({ threadId: 1, createdAt: 1 }),
    getCollection(COLLECTIONS.MESSAGES).createIndex({ customerId: 1 }),
    getCollection(COLLECTIONS.MESSAGES).createIndex({ businessId: 1 }),

    getCollection(COLLECTIONS.PROMOTIONS).createIndex(
      { businessId: 1, isActive: 1, startDate: 1, endDate: 1 },
      { name: "promo_window" }
    ),

    getCollection(COLLECTIONS.DISPUTES).createIndex({ status: 1, createdAt: -1 }),
    getCollection(COLLECTIONS.DISPUTES).createIndex({ bookingId: 1 }),
  ]);

  // eslint-disable-next-line no-console
  console.log("[db] indexes verified");
}

export default { connectDB, getDb, getCollection, closeDB, createIndexes, COLLECTIONS };
