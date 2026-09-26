import "dotenv/config";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { config } from "../shared/config";
import { ALL_COLLECTIONS, Collections } from "../shared/collections";
import {
  type AppDocument,
  connectDb,
  disconnectDb,
  ensureIndexes,
  getCollection,
} from "../shared/db";
import { hashPassword } from "../auth/password";
import { isoNow } from "../shared/utils";

/**
 * Loads `data.json` — the canonical 46-collection schema — into MongoDB.
 *
 * `data.json` is never modified on disk. Two things are adjusted in memory:
 *
 *  1. The placeholder `passwordHash` values in the fixture are not real bcrypt
 *     hashes, so every seeded user gets a hash of the shared demo password.
 *  2. The required admin account is upserted last, so the documented credentials
 *     work even if the fixture's own admin row is missing or renamed.
 *
 * Usage:
 *   npm run seed              # wipe and reseed
 *   npm run seed -- --keep    # insert without deleting existing documents
 */

const SEED_FILE = process.env.SEED_FILE ?? "data.json";
const DEMO_PASSWORD = "12345678";
const ADMIN_EMAIL = "admin.layan@gmail.com";
const ADMIN_USER_ID = "65f000000000000000000001";
const PLACEHOLDER_HASH_PREFIX = "$2b$10$example";

type SeedData = Record<string, Record<string, unknown>[]>;

function parseArgs(argv: string[]): { keep: boolean } {
  return { keep: argv.includes("--keep") };
}

async function readSeedFile(path: string): Promise<SeedData> {
  const raw = await readFile(resolve(process.cwd(), path), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain an object keyed by collection name`);
  }
  return parsed as SeedData;
}

/**
 * Collections whose `_id` is a natural key we manage ourselves; every other
 * collection is cleared outright on a full seed.
 */
async function clearAll(): Promise<void> {
  for (const name of ALL_COLLECTIONS) {
    await getCollection(name).deleteMany({});
  }
  console.log(`Cleared ${ALL_COLLECTIONS.length} collections`);
}

/** Replaces fixture placeholder hashes with a real bcrypt hash. */
async function withRealPasswords(users: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  return users.map((user) => {
    const current = typeof user.passwordHash === "string" ? user.passwordHash : "";
    if (!current.startsWith(PLACEHOLDER_HASH_PREFIX)) return user;
    return { ...user, passwordHash };
  });
}

/** Fills in `createdAt`/`updatedAt` for fixture rows that omit them. */
function withTimestamps(rows: Record<string, unknown>[], now: string): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row.createdAt !== undefined && row.updatedAt !== undefined) return row;
    const createdAt = typeof row.createdAt === "string" ? row.createdAt : now;
    return { ...row, createdAt, updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : createdAt };
  });
}

async function insertRows(
  collection: string,
  rows: Record<string, unknown>[],
  now: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const prepared = withTimestamps(rows, now);
  await getCollection(collection).insertMany(prepared as unknown as readonly AppDocument[], { ordered: false });
  return prepared.length;
}

/**
 * The documented admin account. Upserted rather than inserted so re-running the
 * seed never produces a duplicate-key crash, and always re-hashed so the
 * credentials stay exactly as documented.
 */
async function upsertAdmin(passwordHash: string, now: string): Promise<void> {
  const users = getCollection(Collections.users);
  const doc = {
    _id: ADMIN_USER_ID,
    role: "admin",
    email: ADMIN_EMAIL,
    phone: null,
    passwordHash,
    firstName: "Layan",
    lastName: "Admin",
    avatarUrl: null,
    status: "active",
    emailVerified: true,
    referralCode: "LAYANADMIN",
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await users.updateOne(
    { email: ADMIN_EMAIL },
    { $set: { ...doc, updatedAt: now } },
    { upsert: true },
  );
  console.log(`Admin account ready: ${ADMIN_EMAIL} / ${DEMO_PASSWORD}`);
}

async function main(): Promise<void> {
  const { keep } = parseArgs(process.argv.slice(2));
  const seed = await readSeedFile(SEED_FILE);
  const now = isoNow();

  const unknown = Object.keys(seed).filter(
    (name) => !ALL_COLLECTIONS.includes(name as (typeof ALL_COLLECTIONS)[number]),
  );
  if (unknown.length > 0) {
    throw new Error(`${SEED_FILE} contains collections that are not in Collections: ${unknown.join(", ")}`);
  }

  await connectDb(config.mongoUri, config.dbName);
  if (!keep) await clearAll();

  let inserted = 0;
  for (const [name, rows] of Object.entries(seed)) {
    const prepared =
      name === Collections.users ? await withRealPasswords(rows) : rows;
    inserted += await insertRows(name, prepared, now);
  }

  await upsertAdmin(await hashPassword(DEMO_PASSWORD), now);
  await ensureIndexes();

  const [users, businesses, bookings, services, staff] = await Promise.all([
    getCollection(Collections.users).countDocuments({}),
    getCollection(Collections.businesses).countDocuments({}),
    getCollection(Collections.bookings).countDocuments({}),
    getCollection(Collections.services).countDocuments({}),
    getCollection(Collections.staff).countDocuments({}),
  ]);

  console.log(`Seeded ${inserted} documents from ${SEED_FILE}`);
  console.log(
    `Summary: ${users} users, ${businesses} businesses, ${staff} staff, ${services} services, ${bookings} bookings`,
  );
  await disconnectDb();
}

main().catch(async (error) => {
  console.error("Seed failed:", error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
