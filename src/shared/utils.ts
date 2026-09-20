import { randomUUID } from "node:crypto";

export function generateId(collectionName: string): string {
  const prefix = collectionName.replace(/_/g, "-");
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}