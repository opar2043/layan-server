import { Collections } from "../shared/collections";
import { asUpdate, getCollection, type AppDocument } from "../shared/db";
import { ApiError } from "../shared/errors";
import { generateId, isoNow, requireObject } from "../shared/utils";
import type {
  BookingDoc,
  CustomerPackageDoc,
  LoyaltyPointRow,
  PaymentDoc,
  PromotionDoc,
  WalletDoc,
} from "../types/domain";
import { PaymentMethod, PaymentType } from "../types/enums";

export interface PaymentIntentInput {
  customerUserId: string;
  bookingId?: string;
  orderId?: string;
  method: PaymentMethod;
  amountMinor?: number;
  giftCardCode?: string;
  pointsToRedeem?: number;
  customerPackageId?: string;
  membershipId?: string;
  savedPaymentMethodId?: string;
}

export interface PaymentIntentResult {
  payment: PaymentDoc;
  /** What the client must do next, if anything. */
  clientAction: { type: "none" } | { type: "confirm" | "present_sheet"; reference: string };
  walletDebits: Array<{ bucket: string; amountMinor: number }>;
  walletCredits: Array<{ bucket: string; amountMinor: number }>;
}

const PLATFORM_FEE_BPS = 200; // 2.00%
const BPS = 10_000;

function feeFor(amountMinor: number): number {
  return Math.round((amountMinor * PLATFORM_FEE_BPS) / BPS);
}

async function loadWallet(userId: string): Promise<WalletDoc> {
  const wallets = getCollection<WalletDoc>(Collections.wallets);
  const existing = await wallets.findOne({ userId });
  if (existing) return existing;

  const at = isoNow();
  const doc: WalletDoc = {
    _id: generateId("wlt"),
    userId,
    currency: "GBP",
    balances: { giftCardMinor: 0, refundCreditMinor: 0, referralCreditMinor: 0 },
    loyaltyPoints: [],
    savedCards: [],
    createdAt: at,
    updatedAt: at,
  };
  await wallets.insertOne(doc);
  return doc;
}

async function adjustWallet(
  userId: string,
  deltas: Array<{ bucket: string; amountMinor: number }>,
  description: string,
  refType: string,
  refId: string,
): Promise<void> {
  if (deltas.length === 0) return;
  const wallet = await loadWallet(userId);
  const balances = { ...(wallet.balances as Record<string, number>) };
  const walletId = String(wallet._id);
  const at = isoNow();

  for (const delta of deltas) {
    if (delta.amountMinor === 0) continue;
    const current = balances[delta.bucket] ?? 0;
    const next = current + delta.amountMinor;
    if (next < 0) {
      throw ApiError.unprocessable(
        `Insufficient ${delta.bucket.replace("Minor", "")} balance`,
        { bucket: delta.bucket, available: current, requested: Math.abs(delta.amountMinor) },
      );
    }
    balances[delta.bucket] = next;

    await getCollection(Collections.walletTransactions).insertOne({
      _id: generateId("wtx"),
      walletId,
      userId,
      bucket: delta.bucket,
      direction: delta.amountMinor > 0 ? "credit" : "debit",
      amountMinor: Math.abs(delta.amountMinor),
      balanceAfterMinor: next,
      refType,
      refId,
      description,
      createdAt: at,
      updatedAt: at,
    });
  }

  await getCollection(Collections.wallets).updateOne(
    { _id: walletId },
    { $set: { balances, updatedAt: at } },
  );
}

/**
 * One endpoint for every tender type. `method` in the body picks the branch; the
 * caller never gets to choose an amount that does not match the booking or order.
 */
export async function createPaymentIntent(
  input: PaymentIntentInput,
): Promise<PaymentIntentResult> {
  const at = isoNow();
  const bookings = getCollection<BookingDoc>(Collections.bookings);
  let businessId = "";
  let expectedMinor: number;
  let type: string = PaymentType.BALANCE;

  if (input.bookingId) {
    const booking = await bookings.findOne({ _id: input.bookingId });
    if (!booking) throw ApiError.notFound("Booking not found");
    if (booking.customerUserId !== input.customerUserId) {
      throw ApiError.forbidden("This booking belongs to another account");
    }
    businessId = booking.businessId;
    if (booking.deposit.status === "due" || booking.deposit.status === "pending") {
      expectedMinor = booking.deposit.amountMinor;
      type = PaymentType.DEPOSIT;
    } else {
      expectedMinor = Math.max(
        0,
        booking.pricing.totalMinor - (booking.deposit.status === "paid" ? booking.deposit.amountMinor : 0),
      );
      type = PaymentType.BALANCE;
    }
  } else if (input.orderId) {
    const order = await getCollection(Collections.orders).findOne({ _id: input.orderId });
    if (!order) throw ApiError.notFound("Order not found");
    if (order.customerUserId !== input.customerUserId) {
      throw ApiError.forbidden("This order belongs to another account");
    }
    businessId = String(order.businessId);
    expectedMinor = Math.max(0, Number(order.amountDueMinor ?? 0));
    type = PaymentType.PRODUCT;
  } else {
    throw ApiError.badRequest("Provide either bookingId or orderId");
  }

  if (input.amountMinor !== undefined && input.amountMinor !== expectedMinor) {
    throw ApiError.badRequest("amountMinor does not match the outstanding balance", {
      expected: expectedMinor,
      received: input.amountMinor,
    });
  }
  if (expectedMinor <= 0) {
    throw ApiError.unprocessable("Nothing is outstanding on this booking");
  }

  const walletDebits: Array<{ bucket: string; amountMinor: number }> = [];
  const walletCredits: Array<{ bucket: string; amountMinor: number }> = [];
  let remainingMinor = expectedMinor;
  let requiresClientConfirmation = false;
  let reference = "";

  switch (input.method) {
    case PaymentMethod.GIFT_CARD: {
      if (!input.giftCardCode) throw ApiError.badRequest("giftCardCode is required");
      const cards = getCollection(Collections.giftCards);
      const card = await cards.findOne({ code: input.giftCardCode.toUpperCase() });
      if (!card) throw ApiError.notFound("Gift card not found");
      if (card.status !== "active") throw ApiError.unprocessable("Gift card is not active");
      if (new Date(String(card.expiresAt)).getTime() < Date.now()) {
        throw ApiError.unprocessable("Gift card has expired");
      }
      const balance = Number(card.balanceMinor ?? 0);
      if (balance <= 0) throw ApiError.unprocessable("Gift card has no remaining balance");
      const applied = Math.min(balance, remainingMinor);
      await cards.updateOne(
        { _id: card._id },
        {
          $set: {
            balanceMinor: balance - applied,
            status: balance - applied === 0 ? "redeemed" : "active",
            updatedAt: at,
          },
        },
      );
      remainingMinor -= applied;
      walletDebits.push({ bucket: "gift_card", amountMinor: -applied });
      break;
    }

    case PaymentMethod.LOYALTY_POINTS: {
      const points = input.pointsToRedeem ?? 0;
      if (points <= 0) throw ApiError.badRequest("pointsToRedeem must be positive");
      // 100 points = £1.00, matching the seeded `redeemRules`.
      const creditMinor = Math.floor((points / 100) * 100);
      if (creditMinor <= 0) {
        throw ApiError.unprocessable("Minimum redemption is 100 points");
      }
      if (creditMinor > remainingMinor) {
        throw ApiError.unprocessable("Points would exceed the outstanding balance");
      }
      const programs = getCollection(Collections.loyaltyPrograms);
      const program = await programs.findOne({ businessId, status: "active" });
      if (!program) throw ApiError.unprocessable("This business has no active loyalty program");

      const wallet = await loadWallet(input.customerUserId);
      const entry = (wallet.loyaltyPoints as Array<{ businessId: string; points: number }>).find(
        (row) => row.businessId === businessId,
      );
      const available = entry?.points ?? 0;
      if (available < points) {
        throw ApiError.unprocessable("Not enough loyalty points", { available });
      }

      await programs.updateOne({ _id: program._id }, { $set: { updatedAt: at } });
      await getCollection(Collections.loyaltyTransactions).insertOne({
        _id: generateId("lty"),
        businessId,
        programId: program._id,
        userId: input.customerUserId,
        type: "redeem",
        points: -points,
        balanceAfter: available - points,
        refType: input.bookingId ? "booking" : "order",
        refId: input.bookingId ?? input.orderId,
        note: `Redeemed ${points} points`,
        createdAt: at,
        updatedAt: at,
      });
      const nextPoints = (wallet.loyaltyPoints as LoyaltyPointRow[]).map(
        (row) => (row.businessId === businessId ? { ...row, points: row.points - points } : row),
      );
      await getCollection<WalletDoc>(Collections.wallets).updateOne(
        { _id: wallet._id },
        asUpdate<WalletDoc>({ $set: { loyaltyPoints: nextPoints, updatedAt: at } }),
      );
      remainingMinor -= creditMinor;
      walletDebits.push({ bucket: "loyalty_credit", amountMinor: -creditMinor });
      break;
    }

    case PaymentMethod.PACKAGE_SESSION: {
      if (!input.customerPackageId) throw ApiError.badRequest("customerPackageId is required");
      const packages = getCollection<CustomerPackageDoc>(Collections.customerPackages);
      const pkg = await packages.findOne({
        _id: input.customerPackageId,
        userId: input.customerUserId,
        status: "active",
      });
      if (!pkg) throw ApiError.notFound("Active package not found");
      if (Number(pkg.sessionsRemaining ?? 0) <= 0) {
        throw ApiError.unprocessable("Package has no remaining sessions");
      }
      if (new Date(String(pkg.expiresAt)).getTime() < Date.now()) {
        throw ApiError.unprocessable("Package has expired");
      }
      await packages.updateOne(
        { _id: pkg._id },
        asUpdate<CustomerPackageDoc>({ $inc: { sessionsRemaining: -1 }, $set: { updatedAt: at } }),
      );
      await packages.updateOne(
        { _id: pkg._id, sessionsRemaining: { $lte: 0 } },
        { $set: { status: "exhausted", updatedAt: at } },
      );
      if (input.bookingId) {
        // Session consumption is recorded on the package's own `usage` array;
        // `bookings` has no package field. Note that `customerPackages.paymentId`
        // is the payment that *bought* the package, so it must not be touched
        // here, and the booking's real payment id is pushed by the caller.
        await packages.updateOne(
          { _id: pkg._id },
          asUpdate<CustomerPackageDoc>({
            $push: { usage: { bookingId: input.bookingId, usedAt: at } },
            $set: { updatedAt: at },
          }),
        );
      }
      remainingMinor = 0;
      break;
    }

    case PaymentMethod.MEMBERSHIP: {
      if (!input.membershipId) throw ApiError.badRequest("membershipId is required");
      const membership = await getCollection(Collections.customerMemberships).findOne({
        _id: input.membershipId,
        userId: input.customerUserId,
        status: "active",
      });
      if (!membership) throw ApiError.notFound("Active membership not found");
      remainingMinor = 0;
      break;
    }

    case PaymentMethod.WALLET: {
      const credit = remainingMinor;
      const refType = input.bookingId ? "booking" : "order";
      const refId = input.bookingId ?? input.orderId;
      if (!refId) throw ApiError.badRequest("bookingId or orderId is required");
      await adjustWallet(
        input.customerUserId,
        [{ bucket: "refundCreditMinor", amountMinor: -credit }],
        "Paid booking with wallet refund credit",
        refType,
        refId,
      );
      walletDebits.push({ bucket: "refundCreditMinor", amountMinor: -credit });
      remainingMinor = 0;
      break;
    }

    case PaymentMethod.SAVED_CARD: {
      if (!input.savedPaymentMethodId) {
        throw ApiError.badRequest("savedPaymentMethodId is required");
      }
      const wallet = await loadWallet(input.customerUserId);
      const cards = Array.isArray(wallet.savedCards) ? wallet.savedCards : [];
      const match = cards.find(
        (card) =>
          (card as { providerPaymentMethodId?: string }).providerPaymentMethodId ===
          input.savedPaymentMethodId,
      );
      if (!match) throw ApiError.notFound("Saved card not found");
      requiresClientConfirmation = true;
      reference = input.savedPaymentMethodId;
      break;
    }

    case PaymentMethod.CARD:
    case PaymentMethod.APPLE_PAY:
    case PaymentMethod.GOOGLE_PAY: {
      requiresClientConfirmation = true;
      reference = `pi_${generateId("pi").slice(-10)}`;
      break;
    }

    case PaymentMethod.CASH: {
      break;
    }

    default: {
      throw ApiError.badRequest("Unsupported payment method");
    }
  }

  const chargedMinor = expectedMinor - remainingMinor;
  const feeMinor = feeFor(chargedMinor);
  const provider = requiresClientConfirmation
    ? input.method === PaymentMethod.CARD
      ? "stripe"
      : input.method === PaymentMethod.APPLE_PAY
        ? "apple_pay"
        : "google_pay"
    : "internal";

  const payment: PaymentDoc = {
    _id: generateId("pay"),
    businessId,
    bookingId: input.bookingId ?? null,
    orderId: input.orderId ?? null,
    customerUserId: input.customerUserId,
    type,
    method: input.method,
    amountMinor: chargedMinor,
    tipMinor: 0,
    currency: "GBP",
    provider,
    providerPaymentIntentId: requiresClientConfirmation ? reference : null,
    status: requiresClientConfirmation ? "requires_action" : "succeeded",
    feeMinor,
    netMinor: Math.max(0, chargedMinor - feeMinor),
    refunds: [],
    payoutId: null,
    paidAt: requiresClientConfirmation ? null : at,
    createdAt: at,
    updatedAt: at,
  };

  await getCollection<PaymentDoc>(Collections.payments).insertOne(payment);

  if (payment.status === "succeeded") {
    await applySuccessfulPayment(payment, input.customerUserId, at);
  }

  return {
    payment,
    clientAction: requiresClientConfirmation
      ? {
          type: input.method === PaymentMethod.SAVED_CARD ? "confirm" : "present_sheet",
          reference,
        }
      : { type: "none" },
    walletDebits: walletDebits.filter((entry) => entry.amountMinor !== 0),
    walletCredits,
  };
}

async function applySuccessfulPayment(
  payment: PaymentDoc,
  userId: string,
  at: string,
): Promise<void> {
  if (payment.bookingId) {
    const bookings = getCollection<BookingDoc>(Collections.bookings);
    const booking = await bookings.findOne({ _id: payment.bookingId });
    if (!booking) return;

    if (payment.type === PaymentType.DEPOSIT) {
      // The deposit is what confirms the booking.
      await bookings.updateOne(
        { _id: booking._id },
        {
          $set: {
            status: "confirmed",
            "deposit.paymentId": payment._id,
            "deposit.status": "paid",
            updatedAt: at,
          },
          $push: {
            paymentIds: payment._id,
            statusHistory: { status: "confirmed", at, by: userId },
          },
        },
      );
    } else {
      await bookings.updateOne(
        { _id: booking._id },
        {
          $set: { updatedAt: at },
          $push: { paymentIds: payment._id },
        },
      );
    }
  }

  if (payment.orderId) {
    const orders = getCollection(Collections.orders);
    const order = await orders.findOne({ _id: payment.orderId });
    if (!order) return;
    const paid = Number(order.amountPaidMinor ?? 0) + payment.amountMinor;
    const due = Math.max(0, Number(order.totalMinor ?? 0) - paid);
    await orders.updateOne(
      { _id: order._id },
      asUpdate<AppDocument>({
        $set: {
          amountPaidMinor: paid,
          amountDueMinor: due,
          status: due === 0 ? "paid" : "partially_paid",
          ...(due === 0 ? { closedAt: at } : {}),
          updatedAt: at,
        },
        $push: { paymentIds: payment._id },
      }),
    );
  }
}

export interface RefundInput {
  paymentId: string;
  businessId: string;
  amountMinor?: number;
  reason: string;
  adminId?: string;
}

export interface RefundResult {
  payment: PaymentDoc;
  refundId: string;
  amountMinor: number;
}

export async function refundPayment(input: RefundInput): Promise<RefundResult> {
  const payments = getCollection<PaymentDoc>(Collections.payments);
  const payment = await payments.findOne({ _id: input.paymentId, businessId: input.businessId });
  if (!payment) throw ApiError.notFound("Payment not found");
  if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
    throw ApiError.unprocessable(`A "${payment.status}" payment cannot be refunded`);
  }

  const alreadyRefunded = payment.refunds.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const refundable = payment.amountMinor - alreadyRefunded;
  const amountMinor = input.amountMinor ?? refundable;

  if (amountMinor <= 0) throw ApiError.badRequest("amountMinor must be positive");
  if (amountMinor > refundable) {
    throw ApiError.unprocessable("Refund exceeds the remaining refundable amount", {
      refundable,
      requested: amountMinor,
    });
  }

  const at = isoNow();
  const refundId = `re_${generateId("rf").slice(-8)}`;
  const fullyRefunded = alreadyRefunded + amountMinor >= payment.amountMinor;

  const updated = await payments.findOneAndUpdate(
    { _id: payment._id },
    {
      $set: {
        status: fullyRefunded ? "refunded" : "partially_refunded",
        netMinor: Math.max(0, payment.netMinor - amountMinor),
        updatedAt: at,
      },
      $push: {
        refunds: {
          refundId,
          amountMinor,
          reason: input.reason,
          status: "succeeded",
          createdAt: at,
        },
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) throw ApiError.conflict("Payment changed while refunding");

  if (updated.bookingId) {
    const bookings = getCollection<BookingDoc>(Collections.bookings);
    await bookings.updateOne(
      { _id: updated.bookingId },
      {
        $set: {
          "deposit.status": fullyRefunded ? "refunded" : "partially_refunded",
          updatedAt: at,
        },
      },
    );
  }

  return { payment: updated, refundId, amountMinor };
}

export function parseRefundBody(body: unknown): { amountMinor?: number; reason: string } {
  const source = requireObject(body, "body");
  const reason = typeof source.reason === "string" && source.reason.trim() ? source.reason.trim() : "requested_by_business";
  const amount =
    source.amountMinor === undefined ? undefined : Number(source.amountMinor);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    throw ApiError.badRequest("amountMinor must be a positive number");
  }
  return { ...(amount === undefined ? {} : { amountMinor: Math.round(amount) }), reason };
}
