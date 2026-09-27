import { CollectionName, getCollection } from "./db";
import { serialize } from "./helpers";
import { Document, ObjectId } from "mongodb";

/**
 * Minimal stand-in for Mongoose's `.populate()`.
 *
 * The spec asks list endpoints to "populate service name/price/duration" and the
 * waitlist endpoint to "populate customer name/email + service name". With the
 * native driver that means resolving ObjectId refs ourselves, so this does one
 * `$in` query per ref field and inlines the result under the target key.
 *
 *   await populate(bookingDocs, [
 *     { field: "serviceId", collection: COLLECTIONS.SERVICES },
 *     { field: "customerId", collection: COLLECTIONS.USERS, as: "customer" },
 *   ]);
 *
 * The resolved document lands at `doc[as ?? singular(field)]` as a plain object
 * with a string `_id`. The original ObjectId field is left untouched so the
 * client can still read it.
 */

export interface PopulateSpec {
  /** Field on the source document holding the ObjectId (or array of ObjectIds). */
  field: string;
  collection: CollectionName;
  /** Key to inline the resolved document under. Defaults to the de-pluralised field. */
  as?: string;
  /** Restrict the embedded fields (recommended — avoids leaking credential hashes). */
  select?: string[];
}

function defaultKey(field: string): string {
  return field.endsWith("Id") ? field.slice(0, -2) : field;
}

function pickFields(
  doc: Record<string, unknown>,
  select: string[] | undefined
): Record<string, unknown> {
  if (!select) {
    return serialize(doc as Document) ?? {};
  }
  const projected: Record<string, unknown> = {};
  for (const field of select) {
    if (field in doc) projected[field] = doc[field];
  }
  return serialize(projected as Document) ?? {};
}

function toIdString(value: unknown): string | null {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === "string") return value;
  return null;
}

async function loadCollection(
  collection: CollectionName,
  ids: string[],
  select: string[] | undefined
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return map;

  const cursor = getCollection(collection).find(
    { _id: { $in: ids.map((id) => new ObjectId(id)) } },
    select ? { projection: select.reduce<Record<string, unknown>>((acc, f) => ({ ...acc, [f]: 1 }), {}) } : undefined
  );

  for await (const doc of cursor) {
    const id = toIdString(doc._id);
    if (id) map.set(id, pickFields(doc as Record<string, unknown>, select));
  }
  return map;
}

/** Resolves the refs described by `specs` across a list of documents. */
export async function populateMany(
  docs: Document[],
  specs: PopulateSpec[]
): Promise<Record<string, unknown>[]> {
  if (docs.length === 0) return [];

  // One $in query per (spec, collection) instead of one per document.
  const perSpec = await Promise.all(
    specs.map(async (spec) => {
      const ids = new Set<string>();
      for (const doc of docs) {
        const value = doc[spec.field];
        if (Array.isArray(value)) {
          for (const item of value) {
            const id = toIdString(item);
            if (id) ids.add(id);
          }
        } else {
          const id = toIdString(value);
          if (id) ids.add(id);
        }
      }
      const map = await loadCollection(spec.collection, [...ids], spec.select);
      return { spec, map };
    })
  );

  return docs.map((doc) => {
    const out = (serialize(doc) ?? {}) as Record<string, unknown>;
    for (const { spec, map } of perSpec) {
      const value = doc[spec.field];
      const key = spec.as ?? defaultKey(spec.field);
      if (Array.isArray(value)) {
        out[key] = value
          .map((item) => {
            const id = toIdString(item);
            return id ? map.get(id) ?? null : null;
          })
          .filter(Boolean);
      } else {
        const id = toIdString(value);
        out[key] = id ? map.get(id) ?? null : null;
      }
    }
    return out;
  });
}

/** Convenience wrapper for a single document. */
export async function populateOne(
  doc: Document | null,
  specs: PopulateSpec[]
): Promise<Record<string, unknown> | null> {
  if (!doc) return null;
  const [result] = await populateMany([doc], specs);
  return result ?? null;
}

export default { populateMany, populateOne };
