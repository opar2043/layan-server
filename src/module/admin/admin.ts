import { ApiError } from "../../shared/errors";
import { Collections } from "../../shared/collections";
import { asUpdate, getCollection } from "../../shared/db";
import type { Filter } from "mongodb";
import { generateId, isoNow, requireObject, requireString } from "../../shared/utils";
import type { Paginated } from "../../shared/response";
import type {
  AppDocument,
  BadgeAwardDoc,
  BusinessDoc,
  DisputeDoc,
  FraudFlagDoc,
  ReviewDoc,
  UserDoc,
} from "../../types/domain";
import { UserRole } from "../../types/enums";
import { writeAdminActionLog } from "../../services/admin-log.service";
import { detectFraud } from "../../services/fraud.service";
import { refundPayment } from "../../services/payment.service";
import { sendNotification } from "../../services/notification.service";

/**
 * Platform administration logic.
 *
 * Every mutation here writes an `adminActionLogs` entry before returning, so
 * there is a complete record of who changed what. Two invariants are worth
 * calling out:
 *
 *  - An admin cannot change their own role or status, so a compromised admin
 *    account cannot quietly promote a peer or lock itself out of the audit log.
 *  - Resolving a dispute in the customer's favour issues a real refund through
 *    the payment service. Money movement is never a bare status flip.
 */

export interface Paging {
  page: number;
  pageSize: number;
}

/** Optional query filters. `undefined` is allowed so callers can spread a lookup. */
export interface OptionalFilter {
  role?: string | undefined;
  status?: string | undefined;
  q?: string | undefined;
  severity?: string | undefined;
  businessId?: string | undefined;
  adminId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
}

export function paginate<T>(data: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { data, page, pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize) };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Platform counts for the moderation queues. */
export async function getDashboard(): Promise<Record<string, unknown>> {
  const [users, businesses, openVerifications, openFlags, openDisputes, heldReviews] =
    await Promise.all([
      getCollection<UserDoc>(Collections.users).countDocuments({}),
      getCollection<BusinessDoc>(Collections.businesses).countDocuments({}),
      getCollection(Collections.verificationRequests).countDocuments({ status: "pending" }),
      getCollection<FraudFlagDoc>(Collections.fraudFlags).countDocuments({
        status: { $in: ["open", "investigating"] },
      }),
      getCollection<DisputeDoc>(Collections.disputes).countDocuments({
        status: { $in: ["open", "under_review"] },
      }),
      getCollection(Collections.reviews).countDocuments({ status: "under_review" }),
    ]);

  return {
    users,
    businesses,
    queues: {
      verificationRequests: openVerifications,
      fraudFlags: openFlags,
      disputes: openDisputes,
      reviewsHeldForModeration: heldReviews,
    },
  };
}

/** Searchable user list. `passwordHash` is never included in the projection. */
export async function listUsers(
  paging: Paging,
  filters: OptionalFilter,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = {};
  if (filters.role) filter.role = filters.role;
  if (filters.status) filter.status = filters.status;
  if (filters.q) {
    const escaped = escapeRegex(filters.q);
    filter.$or = [
      { email: { $regex: escaped, $options: "i" } },
      { firstName: { $regex: escaped, $options: "i" } },
      { lastName: { $regex: escaped, $options: "i" } },
    ];
  }

  const collection = getCollection<UserDoc>(Collections.users);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return paginate(
    docs.map((user) => ({
      _id: user._id,
      role: user.role,
      adminRole: user.adminRole ?? null,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      status: user.status,
      emailVerified: user.emailVerified === true,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
    })),
    total,
    paging.page,
    paging.pageSize,
  );
}

const USER_STATUSES = ["active", "suspended", "restricted", "deleted"] as const;

/** Suspend, restrict, restore or delete an account. */
export async function setUserStatus(
  adminId: string,
  userId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = requireString(body.status, "status");
  if (!(USER_STATUSES as readonly string[]).includes(status)) {
    throw ApiError.badRequest(`status must be one of ${USER_STATUSES.join(", ")}`);
  }
  const nextStatus = status as UserDoc["status"];

  const user = await getCollection<UserDoc>(Collections.users).findOne({ _id: userId });
  if (!user) throw ApiError.notFound("User not found");
  if (user._id === adminId) {
    throw ApiError.unprocessable("You cannot change your own account status");
  }

  await getCollection<UserDoc>(Collections.users).updateOne(
    { _id: userId },
    { $set: { status: nextStatus, updatedAt: isoNow() } },
  );
  await writeAdminActionLog({
    adminId,
    action: "user.status_changed",
    targetType: "user",
    targetId: userId,
    details: { from: user.status, to: nextStatus, reason: body.reason ?? null },
  });

  return { _id: userId, status: nextStatus };
}

/** The only path by which a role ever changes. */
export async function setUserRole(
  adminId: string,
  userId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const role = requireString(body.role, "role");
  if (!Object.values(UserRole).includes(role as UserRole)) {
    throw ApiError.badRequest(`role must be one of ${Object.values(UserRole).join(", ")}`);
  }
  if (userId === adminId) throw ApiError.unprocessable("You cannot change your own role");

  const nextRole = role as UserRole;
  const user = await getCollection<UserDoc>(Collections.users).findOne({ _id: userId });
  if (!user) throw ApiError.notFound("User not found");

  await getCollection<UserDoc>(Collections.users).updateOne(
    { _id: userId },
    { $set: { role: nextRole, updatedAt: isoNow() } },
  );
  await writeAdminActionLog({
    adminId,
    action: "user.role_changed",
    targetType: "user",
    targetId: userId,
    details: { from: user.role, to: nextRole, reason: body.reason ?? null },
  });

  return { _id: userId, role: nextRole };
}

export async function listVerificationRequests(
  paging: Paging,
  status?: string,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const collection = getCollection(Collections.verificationRequests);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ submittedAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs as Record<string, unknown>[], total, paging.page, paging.pageSize);
}

/**
 * Approve or reject an identity/business verification.
 *
 * Approving grants a `<type>_verified` badge. That badge is explicitly *not*
 * computable, so this is the only code path in the system that can create it —
 * every other badge comes from `recomputeBadges`.
 */
export async function decideVerificationRequest(
  adminId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const decision = requireString(body.decision, "decision");
  if (decision !== "approved" && decision !== "rejected") {
    throw ApiError.badRequest("decision must be 'approved' or 'rejected'");
  }

  const request = await getCollection(Collections.verificationRequests).findOne({ _id: id });
  if (!request) throw ApiError.notFound("Verification request not found");
  if (request.status !== "pending") {
    throw ApiError.unprocessable(`This request is already "${request.status}"`);
  }

  const at = isoNow();
  await getCollection(Collections.verificationRequests).updateOne(
    { _id: id },
    {
      $set: {
        status: decision,
        reviewedBy: adminId,
        reviewedAt: at,
        rejectionReason: decision === "rejected" ? requireString(body.reason, "reason") : null,
        updatedAt: at,
      },
    },
  );

  const badgeKey = decision === "approved" ? `${String(request.type)}_verified` : null;
  if (badgeKey) {
    const targetId = String(request.businessId ?? request.userId ?? "");
    const targetCollection = request.businessId ? Collections.businesses : Collections.users;

    await getCollection(Collections.badgeAwards).insertOne({
      _id: generateId("bdg"),
      businessId: request.businessId ? targetId : null,
      staffId: null,
      badgeKey,
      criteria: { grantedBy: adminId, verificationRequestId: id, decision },
      awardedAt: at,
      validUntil: null,
      status: "active",
      createdAt: at,
      updatedAt: at,
    });

    await getCollection<AppDocument>(targetCollection).updateOne(
      { _id: targetId },
      asUpdate<AppDocument>({ $addToSet: { badges: badgeKey }, $set: { updatedAt: at } }),
    );

    if (request.userId) {
      await sendNotification({
        userId: String(request.userId),
        type: "verification_result",
        title: decision === "approved" ? "You are verified" : "Verification unsuccessful",
        body:
          decision === "approved"
            ? "Your Layan trust badge is now live."
            : String(body.reason),
        data: { verificationRequestId: id, decision },
      });
    }
  }

  await writeAdminActionLog({
    adminId,
    action: "verification.decided",
    targetType: "verificationRequest",
    targetId: id,
    details: {
      decision,
      businessId: request.businessId ?? null,
      userId: request.userId ?? null,
      badgeGranted: badgeKey,
      reason: body.reason ?? null,
    },
  });

  return { _id: id, status: decision, badgeGranted: badgeKey };
}

export async function listFraudFlags(
  paging: Paging,
  filters: OptionalFilter,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = {};
  if (filters.status) filter.status = filters.status;
  if (filters.severity) filter.severity = filters.severity;

  const collection = getCollection<FraudFlagDoc>(Collections.fraudFlags);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs as Record<string, unknown>[], total, paging.page, paging.pageSize);
}

export async function runFraudDetection(
  businessId?: string,
): Promise<{ created: number; flags: unknown[] }> {
  const flags = await detectFraud(businessId ? { businessId } : {});
  return { created: flags.length, flags };
}

/**
 * Investigate, restrict, dismiss or action a fraud flag. The action list is
 * append-only, so the handling history survives, and restricting or dismissing
 * takes effect on the target account immediately rather than waiting for a job.
 */
export async function updateFraudFlag(
  adminId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = requireString(body.status, "status");
  const allowed = ["investigating", "restricted", "dismissed", "actioned"];
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(`status must be one of ${allowed.join(", ")}`);
  }
  const nextStatus = status as FraudFlagDoc["status"];

  const flag = await getCollection<FraudFlagDoc>(Collections.fraudFlags).findOne({ _id: id });
  if (!flag) throw ApiError.notFound("Fraud flag not found");

  const at = isoNow();
  await getCollection<FraudFlagDoc>(Collections.fraudFlags).updateOne(
    { _id: id },
    {
      $set: { status: nextStatus, assignedTo: flag.assignedTo ?? adminId, updatedAt: at },
      $push: {
        actions: {
          at,
          by: adminId,
          action: nextStatus,
          note: typeof body.note === "string" ? body.note : null,
        },
      },
    },
  );

  if (flag.targetType === "user") {
    if (nextStatus === "restricted") {
      await getCollection<UserDoc>(Collections.users).updateOne(
        { _id: flag.targetId },
        { $set: { status: "restricted", updatedAt: at } },
      );
    }
    if (nextStatus === "dismissed") {
      // Only lift a restriction this flow applied, so a dismissal cannot
      // silently re-activate an account suspended for an unrelated reason.
      await getCollection<UserDoc>(Collections.users).updateOne(
        { _id: flag.targetId, status: "restricted" },
        { $set: { status: "active", updatedAt: at } },
      );
    }
  }

  await writeAdminActionLog({
    adminId,
    action: "fraud_flag.updated",
    targetType: "fraudFlag",
    targetId: id,
    details: { status: nextStatus, note: body.note ?? null, flagType: flag.type },
  });

  return { _id: id, status: nextStatus };
}

/** Reviews held by the automated moderation rules. */
export async function listHeldReviews(
  paging: Paging,
): Promise<Paginated<Record<string, unknown>>> {
  const collection = getCollection<ReviewDoc>(Collections.reviews);
  const filter: Filter<ReviewDoc> = { status: "under_review" };
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs as Record<string, unknown>[], total, paging.page, paging.pageSize);
}

/** Publish or hide a held review, and link it back onto its booking. */
export async function moderateReview(
  adminId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const decision = requireString(body.decision, "decision");
  if (decision !== "publish" && decision !== "hide") {
    throw ApiError.badRequest("decision must be 'publish' or 'hide'");
  }

  const review = await getCollection<ReviewDoc>(Collections.reviews).findOne({ _id: id });
  if (!review) throw ApiError.notFound("Review not found");

  const at = isoNow();
  const status: ReviewDoc["status"] = decision === "publish" ? "published" : "hidden";
  await getCollection<ReviewDoc>(Collections.reviews).updateOne(
    { _id: id },
    { $set: { status, updatedAt: at } },
  );

  // The review is the source of truth; the booking carries the back-reference.
  if (review.bookingId) {
    await getCollection(Collections.bookings).updateOne(
      { _id: review.bookingId },
      { $set: { reviewId: id, updatedAt: at } },
    );
  }

  await writeAdminActionLog({
    adminId,
    action: "review.moderated",
    targetType: "review",
    targetId: id,
    details: { decision, businessId: review.businessId, reason: body.reason ?? null },
  });

  if (review.customerUserId) {
    await sendNotification({
      userId: review.customerUserId,
      type: "review_moderation_result",
      title: decision === "publish" ? "Your review is live" : "Your review was not published",
      body:
        decision === "publish"
          ? "Thanks for sharing your experience."
          : `Reason: ${String(body.reason ?? "it did not meet our guidelines")}`,
      data: { reviewId: id, decision },
    });
  }

  return { _id: id, status };
}

export async function listDisputes(
  paging: Paging,
  status?: string,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const collection = getCollection<DisputeDoc>(Collections.disputes);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs as Record<string, unknown>[], total, paging.page, paging.pageSize);
}

/** Resolves a dispute, issuing a real refund when the customer is favoured. */
export async function resolveDispute(
  adminId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const outcome = requireString(body.outcome, "outcome");
  const allowed = ["resolved_buyer", "resolved_merchant", "closed"];
  if (!allowed.includes(outcome)) {
    throw ApiError.badRequest(`outcome must be one of ${allowed.join(", ")}`);
  }

  const dispute = await getCollection<DisputeDoc>(Collections.disputes).findOne({ _id: id });
  if (!dispute) throw ApiError.notFound("Dispute not found");
  if (allowed.includes(String(dispute.status))) {
    throw ApiError.unprocessable(`This dispute is already "${dispute.status}"`);
  }

  const at = isoNow();
  const nextStatus = outcome as DisputeDoc["status"];
  let refundId: string | null = null;
  if (nextStatus === "resolved_buyer" && dispute.paymentId) {
    const refund = await refundPayment({
      paymentId: String(dispute.paymentId),
      businessId: String(dispute.businessId),
      reason: `Dispute ${id} resolved in the customer's favour`,
      adminId,
    });
    refundId = refund.refundId;
  }

  await getCollection<DisputeDoc>(Collections.disputes).updateOne(
    { _id: id },
    {
      $set: {
        status: nextStatus,
        assignedTo: adminId,
        resolution: requireString(body.resolution, "resolution"),
        updatedAt: at,
      },
      $push: { timeline: { at, event: nextStatus, by: adminId } },
    },
  );

  await writeAdminActionLog({
    adminId,
    action: "dispute.resolved",
    targetType: "dispute",
    targetId: id,
    details: {
      outcome: nextStatus,
      refundId,
      businessId: dispute.businessId,
      amountMinor: body.amountMinor ?? null,
    },
  });

  if (dispute.raisedBy) {
    await sendNotification({
      userId: String(dispute.raisedBy),
      type: "dispute_resolved",
      title: "Your dispute has been resolved",
      body: requireString(body.resolution, "resolution"),
      data: { disputeId: id, outcome: nextStatus },
    });
  }

  return { _id: id, status: nextStatus, refundId };
}

/** Suspend or reinstate a business. Suspension blocks new bookings immediately. */
export async function setBusinessStatus(
  adminId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = requireString(body.status, "status");
  const allowed = ["active", "pending_verification", "suspended"];
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(`status must be one of ${allowed.join(", ")}`);
  }
  const nextStatus = status as BusinessDoc["status"];

  const business = await getCollection<BusinessDoc>(Collections.businesses).findOne({ _id: id });
  if (!business) throw ApiError.notFound("Business not found");

  await getCollection<BusinessDoc>(Collections.businesses).updateOne(
    { _id: id },
    { $set: { status: nextStatus, updatedAt: isoNow() } },
  );
  await writeAdminActionLog({
    adminId,
    action: "business.status_changed",
    targetType: "business",
    targetId: id,
    details: { from: business.status, to: nextStatus, reason: body.reason ?? null },
  });

  if (business.ownerId) {
    await sendNotification({
      userId: business.ownerId,
      type: "business_status",
      title:
        nextStatus === "suspended" ? "Your business has been suspended" : "Business status updated",
      body:
        nextStatus === "suspended"
          ? String(body.reason ?? "Contact Layan support.")
          : `Status: ${nextStatus}`,
      data: { businessId: id, status: nextStatus },
    });
  }

  return { _id: id, status: nextStatus };
}

/** Computed and admin-granted badges. */
export async function listBadgeAwards(
  paging: Paging,
  businessId?: string,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = {};
  if (businessId) filter.businessId = businessId;

  const collection = getCollection<BadgeAwardDoc>(Collections.badgeAwards);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ awardedAt: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs as Record<string, unknown>[], total, paging.page, paging.pageSize);
}

/** The immutable record of every admin mutation. */
export async function listAuditLogs(
  paging: Paging,
  filters: OptionalFilter,
): Promise<Paginated<Record<string, unknown>>> {
  const filter: Record<string, unknown> = {};
  if (filters.adminId) filter.adminId = filters.adminId;
  if (filters.targetType) filter.targetType = filters.targetType;
  if (filters.targetId) filter.targetId = filters.targetId;

  const collection = getCollection(Collections.adminActionLogs);
  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ at: -1 })
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return paginate(docs as Record<string, unknown>[], total, paging.page, paging.pageSize);
}

export { requireObject, requireString };
