import { MongoClient, type Collection, type Db, type Document } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;
let connecting: Promise<void> | null = null;

// All documents use string _id values (matching data.json), not ObjectId.
export interface AppDocument {
  _id: string;
  [key: string]: unknown;
}

export function connectDb(uri: string, name: string): Promise<void> {
  if (db) return Promise.resolve();
  if (connecting) return connecting;

  connecting = (async () => {
    const next = new MongoClient(uri);
    await next.connect();
    client = next;
    db = client.db(name);
  })().finally(() => {
    connecting = null;
  });

  return connecting;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not connected");
  return db;
}

export function getCollection<T extends Document = AppDocument>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}

export async function disconnectDb(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
