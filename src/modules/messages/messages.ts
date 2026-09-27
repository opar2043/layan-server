import { Filter, ObjectId } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { serialize, serializeMany } from "../../shared/helpers";
import { optionalBoolean, requireString, toObjectId } from "../../shared/validate";
import { MessageSenderRole, Role } from "../../types/enums";
import { ActorContext, resolveActor } from "../../shared/identify.middleware";
import { buildThreadId, IMessage, MessageModel } from "./model";
import { findCustomerIdByFirebaseUid } from "../users/users";

/**
 * POST /api/messages
 *
 * The same endpoint serves both sides of a conversation, so the customer id,
 * business id and sender role are all derived from whichever credential the caller
 * presented rather than read from the body. A customer can therefore never post a
 * message as the business, or into someone else's thread.
 *
 * Body: `{ businessId, text, isAutoFaqReply? }` from a customer,
 *       `{ customerId, text, isAutoFaqReply? }` from the business side.
 */
export async function sendMessage(
  body: Record<string, unknown>,
  res: Response,
  actor: ActorContext
) {
  const text = requireString(body, "text", { min: 1, max: 4000 });
  const isAutoFaqReply = optionalBoolean(body, "isAutoFaqReply") ?? false;

  const messages = MessageModel();
  const now = new Date();

  if (actor.isCustomer) {
    const customerId = actor.customerId as string;
    const businessId = body.businessId ? toObjectId(body.businessId, "businessId") : null;
    if (!businessId) {
      throw ApiError.badRequest('"businessId" is required when a customer sends a message');
    }

    const document = {
      threadId: buildThreadId(customerId, businessId.toHexString()),
      customerId: new ObjectId(customerId),
      businessId,
      senderRole: MessageSenderRole.CUSTOMER,
      text,
      isAutoFaqReply,
      createdAt: now,
    };

    const result = await messages.insertOne(document);
    const created = await messages.findOne({ _id: result.insertedId });
    return sendSuccess(res, 201, "Message sent", { message: serialize(created) });
  }

  // Business side (owner or staff). Staff reply on behalf of their employer's business.
  const businessId = actor.businessId as string;
  const customerId = body.customerId ? toObjectId(body.customerId, "customerId") : null;
  if (!customerId) {
    throw ApiError.badRequest('"customerId" is required when the business sends a message');
  }

  const document = {
    threadId: buildThreadId(customerId.toHexString(), businessId),
    customerId,
    businessId: new ObjectId(businessId),
    senderRole: MessageSenderRole.BUSINESS,
    text,
    isAutoFaqReply,
    createdAt: now,
  };

  const result = await messages.insertOne(document);
  const created = await messages.findOne({ _id: result.insertedId });
  return sendSuccess(res, 201, "Message sent", { message: serialize(created) });
}

/**
 * GET /api/messages — returns one full thread, oldest first.
 * A customer passes `?businessId=`; the business side passes `?customerId=`
 * (defaulting to conversations with their own business).
 */
export async function listMessages(
  query: Record<string, unknown>,
  res: Response,
  actor: ActorContext
) {
  const messages = MessageModel();

  if (actor.isCustomer) {
    const customerId = actor.customerId as string;
    if (typeof query.businessId !== "string" || !query.businessId) {
      throw ApiError.badRequest('"businessId" query parameter is required');
    }
    const businessId = toObjectId(query.businessId, "business id");
    const filter: Filter<IMessage> = { threadId: buildThreadId(customerId, businessId.toHexString()) };

    const docs = await messages.find(filter).sort({ createdAt: 1 }).toArray();
    return sendSuccess(res, 200, "Thread retrieved", {
      threadId: filter.threadId,
      messages: serializeMany(docs),
    });
  }

  if (actor.isAdmin) {
    throw ApiError.forbidden("Admins do not have a business inbox");
  }

  const businessId = actor.businessId as string;

  if (typeof query.customerId !== "string" || !query.customerId) {
    // No specific conversation requested: return every thread for this business.
    const docs = await messages
      .find({ businessId: new ObjectId(businessId) })
      .sort({ createdAt: 1 })
      .toArray();
    return sendSuccess(res, 200, "Messages retrieved", { messages: serializeMany(docs) });
  }

  const customerId = toObjectId(query.customerId, "customer id");
  const filter: Filter<IMessage> = { threadId: buildThreadId(customerId.toHexString(), businessId) };

  const docs = await messages.find(filter).sort({ createdAt: 1 }).toArray();
  return sendSuccess(res, 200, "Thread retrieved", {
    threadId: filter.threadId,
    messages: serializeMany(docs),
  });
}

/**
 * GET /api/messages/threads — inbox list for the business side.
 * Sorts by createdAt descending and groups by threadId, so `$first` in each group
 * is the latest message in that conversation.
 */
export async function listThreads(res: Response, actor: ActorContext) {
  if (actor.isCustomer) {
    throw ApiError.forbidden("Only the business side has a thread inbox");
  }
  if (actor.isAdmin) {
    throw ApiError.forbidden("Admins do not have a business inbox");
  }

  const businessId = new ObjectId(actor.businessId as string);

  const threads = await MessageModel()
    .aggregate([
      { $match: { businessId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$threadId",
          lastMessage: { $first: "$$ROOT" },
          messageCount: { $sum: 1 },
        },
      },
      { $sort: { "lastMessage.createdAt": -1 } },
    ])
    .toArray();

  return sendSuccess(res, 200, "Threads retrieved", {
    threads: threads.map((thread) => ({
      threadId: thread._id,
      messageCount: thread.messageCount,
      lastMessage: serialize(thread.lastMessage as IMessage),
    })),
    total: threads.length,
  });
}

export { Role };
export default { sendMessage, listMessages, listThreads };
