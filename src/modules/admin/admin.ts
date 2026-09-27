import { Filter, ObjectId } from "mongodb";
import { Response } from "express";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated } from "../../shared/helpers";
import { populateMany } from "../../shared/populate";
import { COLLECTIONS, getCollection } from "../../shared/db";
import { optionalEnum, optionalString, requireId, requireString, toObjectId } from "../../shared/validate";
import { BookingStatus, DisputeStatus, Role, VerificationStatus } from "../../types/enums";
import { ActorContext, resolveActor } from "../../shared/identify.middleware";
import { IBooking } from "../bookings/model";
import { IBusiness } from "../businesses/model";
import { IUser } from "../users/model";
import { IDispute, DisputeModel } from "./model";
import { findCustomerIdByFirebaseUid } from "../users/users";

const DISPUTE_POPULATE = [
  { field: "customerId", collection: COLLECTIONS.USERS, select: ["name", "email", "phone"] },
  { field: "businessId", collection: COLLECTIONS.BUSINESSES, select: ["businessName", "category"] },
];

/** A customer with at least this many failed bookings is surfaced as a fraud flag. */
const FRAUD_INCIDENT_THRESHOLD = 3;

const FAILED_BOOKING_STATUSES = [
  BookingStatus.CANCELLED,
  BookingStatus.LATE_CANCEL,
  BookingStatus.NO_SHOW,
];

/**
 * GET /api/admin/analytics — platform health, computed with aggregation pipelines
 * rather than pulling documents into memory.
 */
export async function getAnalytics(res: Response) {
  const bookings = getCollection<IBooking>(COLLECTIONS.BOOKINGS);
  const businesses = getCollection<IBusiness>(COLLECTIONS.BUSINESSES);
  const users = getCollection<IUser>(COLLECTIONS.USERS);

  const [businessTotals] = await businesses
    .aggregate<{ total: number; verified: number; pending: number; approved: number; rejected: number }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          verified: { $sum: { $cond: ["$isBusinessVerified", 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$verificationStatus", VerificationStatus.PENDING] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ["$verificationStatus", VerificationStatus.APPROVED] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ["$verificationStatus", VerificationStatus.REJECTED] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  const totalCustomers = await users.countDocuments();

  // $group by status returns ONE ROW PER STATUS, so the whole result set is folded
  // into the zero-initialised breakdown below — reading only the first row would
  // silently drop every other status.
  const statusRows = await bookings
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();

  const breakdown: Record<string, number> = {};
  for (const status of Object.values(BookingStatus)) {
    breakdown[status] = 0;
  }
  for (const row of statusRows) {
    breakdown[row._id] = row.count;
  }

  const totalBookings = Object.keys(breakdown).reduce((sum, key) => sum + breakdown[key], 0);
  const failedCount = FAILED_BOOKING_STATUSES.reduce(
    (sum, status) => sum + (breakdown[status] ?? 0),
    0
  );

  // GMV counts money actually collected, so it is summed over attended bookings only.
  const [revenue] = await bookings
    .aggregate<{ gmv: number; tips: number; paid: number; deposits: number }>([
      { $match: { status: BookingStatus.ATTENDED } },
      {
        $group: {
          _id: null,
          gmv: { $sum: "$amountPaid" },
          tips: { $sum: "$tip" },
          paid: { $sum: "$amountPaid" },
          deposits: { $sum: "$depositAmount" },
        },
      },
    ])
    .toArray();

  const cancellationRate = totalBookings > 0 ? Number(((failedCount / totalBookings) * 100).toFixed(2)) : 0;

  return sendSuccess(res, 200, "Platform analytics retrieved", {
    businesses: {
      total: businessTotals?.total ?? 0,
      verified: businessTotals?.verified ?? 0,
      pending: businessTotals?.pending ?? 0,
      approved: businessTotals?.approved ?? 0,
      rejected: businessTotals?.rejected ?? 0,
    },
    customers: { total: totalCustomers },
    bookings: {
      total: totalBookings,
      byStatus: breakdown,
      failed: failedCount,
      cancellationRatePercent: cancellationRate,
      noShowCount: breakdown[BookingStatus.NO_SHOW] ?? 0,
    },
    revenue: {
      gmv: revenue?.gmv ?? 0,
      tips: revenue?.tips ?? 0,
      amountPaid: revenue?.paid ?? 0,
      depositsHeld: revenue?.deposits ?? 0,
    },
  });
}

/**
 * GET /api/admin/fraud-flags
 *
 * Counts each customer's no-show / cancellation incidents and flags anyone at or
 * above the threshold. Reviewers still make the call — this only surfaces them.
 */
export async function getFraudFlags(res: Response) {
  const rows = await getCollection<IBooking>(COLLECTIONS.BOOKINGS)
    .aggregate<{
      _id: ObjectId;
      customerId: ObjectId;
      incidentCount: number;
      lastIncidentAt: Date;
      /** Raw list of failed statuses; tallied per status in the response. */
      byStatus: string[];
    }>([
      { $match: { status: { $in: FAILED_BOOKING_STATUSES } } },
      {
        $group: {
          _id: "$customerId",
          incidentCount: { $sum: 1 },
          lastIncidentAt: { $max: "$startTime" },
          byStatus: { $push: "$status" },
        },
      },
      { $match: { incidentCount: { $gte: FRAUD_INCIDENT_THRESHOLD } } },
      { $sort: { incidentCount: -1, lastIncidentAt: -1 } },
    ])
    .toArray();

  const userDocs = await getCollection<IUser>(COLLECTIONS.USERS)
    .find(
      { _id: { $in: rows.map((row) => row._id) } },
      { projection: { name: 1, email: 1, phone: 1 } }
    )
    .toArray();

  const userById = new Map(userDocs.map((user) => [user._id.toHexString(), user as IUser]));

  return sendSuccess(res, 200, "Fraud flags retrieved", {
    threshold: FRAUD_INCIDENT_THRESHOLD,
    flaggedCount: rows.length,
    flagged: rows.map((row) => {
      const user = userById.get(row._id.toHexString());
      const tally: Record<string, number> = {};
      for (const status of row.byStatus) {
        tally[status] = (tally[status] ?? 0) + 1;
      }
      return {
        customerId: row._id.toHexString(),
        customer: user
          ? { name: user.name, email: user.email, phone: user.phone }
          : null,
        incidentCount: row.incidentCount,
        incidentsByStatus: tally,
        lastIncidentAt: row.lastIncidentAt,
      };
    }),
  });
}

/**
 * POST /api/admin/disputes — either side of a booking can raise one.
 * The customer id and business id are copied from the booking itself, so a dispute
 * cannot be filed against a booking the caller is not party to.
 */
export async function createDispute(
  body: Record<string, unknown>,
  res: Response,
  actor: ActorContext
) {
  if (actor.isAdmin) {
    throw ApiError.forbidden("Admins resolve disputes, they do not raise them");
  }

  const bookingId = requireId(body, "bookingId");
  const reason = requireString(body, "reason", { min: 10, max: 2000 });
  const customerEvidence = optionalString(body, "customerEvidence", { max: 2000 });
  const businessEvidence = optionalString(body, "businessEvidence", { max: 2000 });

  const bookings = getCollection<IBooking>(COLLECTIONS.BOOKINGS);
  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking) throw ApiError.notFound("Booking not found");

  const typedBooking = booking as IBooking;
  const customerId = typedBooking.customerId.toHexString();
  const businessId = typedBooking.businessId.toHexString();

  if (actor.isCustomer) {
    if (customerId !== actor.customerId) {
      throw ApiError.forbidden("You can only dispute your own bookings");
    }
  } else if (businessId !== actor.businessId) {
    throw ApiError.forbidden("You can only dispute bookings for your own business");
  }

  // Evidence is tagged with whoever supplied it.
  const evidence = actor.isCustomer
    ? { customerEvidence, businessEvidence: undefined }
    : { customerEvidence: undefined, businessEvidence };

  const now = new Date();
  const document = {
    bookingId,
    customerId: typedBooking.customerId,
    businessId: typedBooking.businessId,
    reason,
    customerEvidence: evidence.customerEvidence,
    businessEvidence: evidence.businessEvidence,
    status: DisputeStatus.OPEN,
    createdAt: now,
    updatedAt: now,
  };

  const disputes = DisputeModel();
  const result = await disputes.insertOne(document);
  const created = await disputes.findOne({ _id: result.insertedId });
  const [item] = await populateMany(created ? [created] : [], DISPUTE_POPULATE);

  return sendSuccess(res, 201, "Dispute raised", { dispute: item });
}

/** GET /api/admin/disputes — admin queue, optional status filter. */
export async function listDisputes(query: Record<string, unknown>, res: Response) {
  const pagination = getPagination(query);
  const disputes = DisputeModel();

  const filter: Filter<IDispute> = {};
  if (typeof query.status === "string" && query.status) {
    if (!Object.values(DisputeStatus).includes(query.status as DisputeStatus)) {
      throw ApiError.badRequest('"status" filter is not a valid dispute status', {
        allowed: Object.values(DisputeStatus),
      });
    }
    filter.status = query.status as DisputeStatus;
  }

  const [docs, total] = await Promise.all([
    disputes.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).toArray(),
    disputes.countDocuments(filter),
  ]);

  return sendPaginated(
    res,
    "Disputes retrieved",
    await populateMany(docs, DISPUTE_POPULATE),
    total,
    pagination
  );
}

/** PATCH /api/admin/disputes/:id — admin ruling. */
export async function resolveDispute(
  params: Record<string, string>,
  body: Record<string, unknown>,
  res: Response
) {
  const status = optionalEnum(body, "status", DisputeStatus);
  if (!status) {
    throw ApiError.badRequest('"status" is required', { allowed: Object.values(DisputeStatus) });
  }
  const resolutionNote = optionalString(body, "resolutionNote", { max: 4000 });

  const disputes = DisputeModel();
  const dispute = await disputes.findOne({ _id: toObjectId(params.id, "dispute id") });
  if (!dispute) throw ApiError.notFound("Dispute not found");

  if (
    (status === DisputeStatus.RESOLVED || status === DisputeStatus.REJECTED) &&
    !resolutionNote
  ) {
    throw ApiError.badRequest(
      `"resolutionNote" is required when a dispute is ${status}`
    );
  }

  await disputes.updateOne(
    { _id: (dispute as IDispute)._id },
    {
      $set: {
        status,
        ...(resolutionNote !== undefined ? { resolutionNote } : {}),
        updatedAt: new Date(),
      },
    }
  );

  const updated = await disputes.findOne({ _id: (dispute as IDispute)._id });
  const [item] = await populateMany(updated ? [updated] : [], DISPUTE_POPULATE);

  return sendSuccess(res, 200, `Dispute set to "${status}"`, { dispute: item });
}

export { Role };
export default { getAnalytics, getFraudFlags, createDispute, listDisputes, resolveDispute };
