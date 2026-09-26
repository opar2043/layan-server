import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { asUpdate, getCollection } from "../../shared/db";
import { generateId, isoNow, requireArray, requireObject, requireString } from "../../shared/utils";
import type { BookingDoc, ConversationDoc, MessageDoc, StaffDoc } from "../../types/domain";

/**
 * Shared messaging logic.
 *
 * There is exactly one `Conversation` per booking — customers, staff and owners
 * all read the same thread, and a user only ever sees threads they are a named
 * participant in. Opening a conversation twice returns the existing thread rather
 * than creating a rival one.
 */

export interface Participant {
  userId: string;
  role: "customer" | "business";
}

export async function loadConversation(conversationId: string): Promise<ConversationDoc> {
  const conversation = await getCollection<ConversationDoc>(Collections.conversations).findOne({
    _id: conversationId,
  });
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return conversation;
}

/** Only a listed participant may read or write in a conversation. */
export function assertParticipant(conversation: ConversationDoc, userId: string): void {
  const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
  if (!participants.some((entry) => entry.userId === userId)) {
    throw ApiError.forbidden("You are not part of this conversation");
  }
}

/**
 * Resolves whether the caller is replying for a business, so the message is
 * attributed correctly and a customer cannot masquerade as the salon.
 */
export async function resolveSenderType(userId: string): Promise<"customer" | "business"> {
  const staffCount = await getCollection(Collections.staff).countDocuments({
    userId,
    status: "active",
  });
  if (staffCount > 0) return "business";
  const ownedCount = await getCollection(Collections.businesses).countDocuments({ ownerId: userId });
  return ownedCount > 0 ? "business" : "customer";
}

export async function listConversations(
  userId: string,
  page: number,
  pageSize: number,
): Promise<{ docs: ConversationDoc[]; total: number }> {
  const collection = getCollection<ConversationDoc>(Collections.conversations);
  const [docs, total] = await Promise.all([
    collection
      .find({ "participants.userId": userId })
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    collection.countDocuments({ "participants.userId": userId }),
  ]);
  return { docs, total };
}

/** Opens (or returns) the single thread for a booking. */
export async function openConversation(
  userId: string,
  body: Record<string, unknown>,
): Promise<{ conversation: ConversationDoc; created: boolean }> {
  const bookingId = requireString(body.bookingId, "bookingId");
  const booking = await getCollection<BookingDoc>(Collections.bookings).findOne({ _id: bookingId });
  if (!booking) throw ApiError.notFound("Booking not found");

  const staffRow = await getCollection<StaffDoc>(Collections.staff).findOne({ _id: booking.staffId });
  const staffUserId = staffRow?.userId ?? null;

  const existing = await getCollection<ConversationDoc>(Collections.conversations).findOne({
    bookingId,
  });
  if (existing) {
    // Only a participant gets the existing thread back; anyone else is told the
    // booking does not exist rather than that a conversation is there.
    assertParticipant(existing, userId);
    return { conversation: existing, created: false };
  }

  const at = isoNow();
  const participants: Participant[] = [{ userId: booking.customerUserId, role: "customer" }];
  if (staffUserId && staffUserId !== booking.customerUserId) {
    participants.push({ userId: staffUserId, role: "business" });
  }

  const conversation: ConversationDoc = {
    _id: generateId("cnv"),
    businessId: booking.businessId,
    bookingId,
    customerUserId: booking.customerUserId,
    participants,
    lastMessage: null,
    unread: Object.fromEntries(participants.map((entry) => [entry.userId, 0])),
    status: "open",
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<ConversationDoc>(Collections.conversations).insertOne(conversation);
  return { conversation, created: true };
}

export async function getThread(
  userId: string,
  conversationId: string,
): Promise<{ conversation: ConversationDoc; messages: MessageDoc[] }> {
  const conversation = await loadConversation(conversationId);
  assertParticipant(conversation, userId);

  const messages = await getCollection<MessageDoc>(Collections.messages)
    .find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(200)
    .toArray();
  return { conversation, messages };
}

/**
 * Appends a message, then updates `lastMessage` and every *other* participant's
 * unread counter. The sender's own counter is left alone so sending a message
 * never marks the thread unread for you.
 */
export async function postMessage(
  userId: string,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<MessageDoc> {
  const conversation = await loadConversation(conversationId);
  assertParticipant(conversation, userId);

  const at = isoNow();
  const message: MessageDoc = {
    _id: generateId("msg"),
    conversationId: conversation._id,
    senderId: userId,
    senderType: await resolveSenderType(userId),
    type: "text",
    body: requireString(body.body, "body"),
    attachments: requireArray(body.attachments ?? [], "attachments").map(String),
    isAutoReply: false,
    faqKey: typeof body.faqKey === "string" ? body.faqKey : null,
    readBy: [userId],
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<MessageDoc>(Collections.messages).insertOne(message);

  const inc: Record<string, number> = {};
  for (const entry of conversation.participants) {
    if (entry.userId !== userId) inc[`unread.${entry.userId}`] = 1;
  }

  await getCollection<ConversationDoc>(Collections.conversations).updateOne(
    { _id: conversation._id },
    asUpdate<ConversationDoc>({
      $set: {
        lastMessage: { text: message.body.slice(0, 200), senderId: userId, at },
        updatedAt: at,
      },
      ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
    }),
  );

  return message;
}

/** Clears the caller's unread counter and marks the messages they have now seen. */
export async function markRead(userId: string, conversationId: string): Promise<{ read: boolean }> {
  const conversation = await loadConversation(conversationId);
  assertParticipant(conversation, userId);

  const at = isoNow();
  await getCollection<ConversationDoc>(Collections.conversations).updateOne(
    { _id: conversation._id },
    asUpdate<ConversationDoc>({ $set: { [`unread.${userId}`]: 0, updatedAt: at } }),
  );
  await getCollection<MessageDoc>(Collections.messages).updateMany(
    { conversationId: conversation._id, readBy: { $ne: userId } },
    { $addToSet: { readBy: userId }, $set: { updatedAt: at } },
  );
  return { read: true };
}

/** The badge number for the caller's nav bar. */
export async function unreadCount(userId: string): Promise<{ unread: number; conversations: number }> {
  const conversations = await getCollection<ConversationDoc>(Collections.conversations)
    .find({ [`unread.${userId}`]: { $gt: 0 } })
    .toArray();
  const unread = conversations.reduce((sum, row) => sum + (row.unread?.[userId] ?? 0), 0);
  return { unread, conversations: conversations.length };
}

export { requireObject };
