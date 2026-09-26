import { Collections } from "../shared/collections";
import { getCollection } from "../shared/db";
import { generateId, isoNow } from "../shared/utils";
import { ApiError } from "../shared/errors";
import type { AdminActionLogDoc } from "../types/domain";

/**
 * Every admin mutation writes here. This is the only audit trail, so it is
 * written for creates, updates and deletes alike — and it is written *before*
 * the response is sent, never fire-and-forget.
 */
export interface AdminLogInput {
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
}

export async function writeAdminActionLog(input: AdminLogInput): Promise<AdminActionLogDoc> {
  const at = isoNow();
  const doc: AdminActionLogDoc = {
    _id: generateId("aal"),
    adminId: input.adminId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    details: input.details ?? {},
    at,
    createdAt: at,
    updatedAt: at,
  };
  await getCollection<AdminActionLogDoc>(Collections.adminActionLogs).insertOne(doc);
  return doc;
}
