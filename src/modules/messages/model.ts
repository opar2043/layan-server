import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { MessageSenderRole } from "../../types/enums";

/**
 * One customer <-> business conversation. `threadId` is always
 * `"<customerId>_<businessId>"`, which makes a thread lookup a single indexed
 * equality query instead of a scan across the pair of ids.
 */
export interface IMessage extends Document {
  threadId: string;
  customerId: Document["_id"];
  businessId: Document["_id"];
  senderRole: MessageSenderRole;
  text: string;
  /** True when the business side answered from a canned FAQ rather than by hand. */
  isAutoFaqReply: boolean;
  createdAt: Date;
}

export const MessageModel = () => getCollection<IMessage>(COLLECTIONS.MESSAGES);

/** Builds the canonical thread key for a customer/business pair. */
export function buildThreadId(customerId: string, businessId: string): string {
  return `${customerId}_${businessId}`;
}

export default MessageModel;
