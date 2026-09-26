import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { generateId, isoNow } from "../shared/utils";
import type { AppDocument } from "../shared/db";

export interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels?: string[];
}

/**
 * Notification outbox. Delivery to push/SMS/email providers is a separate worker;
 * this records the intent with the channels the customer consented to.
 */
export async function sendNotification(input: NotificationInput): Promise<AppDocument> {
  const at = isoNow();
  const channels = input.channels ?? ["push"];
  const doc: AppDocument = {
    _id: generateId("ntf"),
    userId: input.userId,
    type: input.type,
    channels,
    title: input.title,
    body: input.body,
    data: input.data ?? {},
    status: "queued",
    sentAt: null,
    readAt: null,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection(Collections.notifications).insertOne(doc);
  return doc;
}
