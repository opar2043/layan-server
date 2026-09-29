import { Response } from "express";
import { ObjectId } from "mongodb";
import { ApiError } from "../../shared/apiError";
import { sendSuccess } from "../../shared/apiResponse";
import { getPagination, sendPaginated, serialize, serializeMany } from "../../shared/helpers";
import { optionalString, requireNumber } from "../../shared/validate";
import { WalletTransactionType } from "../../types/enums";
import { ActorContext, resolveActor } from "../../shared/identify.middleware";
import {
  BALANCE_FIELD,
  IWallet,
  REDEEM_TYPES,
  TOPUP_TYPES,
  WalletModel,
  WalletTransactionModel,
} from "./model";
import { findCustomerIdByFirebaseUid } from "../users/users";

async function requireCustomerActor(firebaseUid: string | undefined): Promise<ActorContext> {
  const actor = await resolveActor({ firebaseUid }, findCustomerIdByFirebaseUid);
  if (!actor.customerId) {
    throw ApiError.forbidden("This endpoint is only available to customers");
  }
  return actor;
}

/** Returns the customer's wallet, creating a zeroed one on first access. */
async function getOrCreateWallet(customerId: string): Promise<IWallet> {
  const wallets = WalletModel();
  const customerObjectId = new ObjectId(customerId);

  const existing = (await wallets.findOne({ customerId: customerObjectId })) as IWallet | null;
  if (existing) return existing;

  const now = new Date();
  const document = {
    customerId: customerObjectId,
    loyaltyPoints: 0,
    giftCardBalance: 0,
    packageSessions: [],
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await wallets.insertOne(document);
    return (await wallets.findOne({ _id: result.insertedId })) as IWallet;
  } catch (error) {
    // Two concurrent first reads: the unique index on customerId means one wins,
    // so re-read and use the winner's wallet. Any other failure (or a re-read that
    // still finds nothing) must surface — returning null here would hand the
    // customer a blank wallet and mask a real database error.
    const winner = (await wallets.findOne({ customerId: customerObjectId })) as IWallet | null;
    if (winner) return winner;
    throw error;
  }
}

/** GET /api/wallet/me */
export async function getMyWallet(firebaseUid: string | undefined, res: Response) {
  const actor = await requireCustomerActor(firebaseUid);
  const wallet = await getOrCreateWallet(actor.customerId as string);
  return sendSuccess(res, 200, "Wallet retrieved", { wallet: serialize(wallet) });
}

/**
 * POST /api/wallet/me/topup
 * Body `{ type: loyalty_earn | referral_credit | gift_card_topup, amount, note? }`.
 * Credits the matching balance and appends a ledger row in the same flow.
 */
export async function topupWallet(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const actor = await requireCustomerActor(firebaseUid);
  const amount = requireNumber(body, "amount", { min: 0.01 });
  const note = optionalString(body, "note", { max: 300 });

  const type = body.type as WalletTransactionType;
  if (!type || !(TOPUP_TYPES as readonly string[]).includes(type)) {
    throw ApiError.badRequest('"type" must be one of the credit types', {
      allowed: TOPUP_TYPES,
    });
  }

  const wallet = await getOrCreateWallet(actor.customerId as string);
  const field = BALANCE_FIELD[type];

  // Credit the balance, then record it. The ledger is append-only.
  await WalletModel().updateOne(
    { _id: wallet._id },
    { $inc: { [field]: amount }, $set: { updatedAt: new Date() } }
  );

  await WalletTransactionModel().insertOne({
    customerId: wallet.customerId,
    type,
    amount,
    note,
    createdAt: new Date(),
  });

  const updated = await WalletModel().findOne({ _id: wallet._id });
  return sendSuccess(res, 200, "Wallet credited", { wallet: serialize(updated) });
}

/**
 * POST /api/wallet/me/redeem
 * Body `{ type: loyalty_redeem | gift_card_redeem, amount }`.
 * Rejects with 400 when the balance is short, so the customer never spends more
 * than they hold.
 */
export async function redeemFromWallet(
  firebaseUid: string | undefined,
  body: Record<string, unknown>,
  res: Response
) {
  const actor = await requireCustomerActor(firebaseUid);
  const amount = requireNumber(body, "amount", { min: 0.01 });

  const type = body.type as WalletTransactionType;
  if (!type || !(REDEEM_TYPES as readonly string[]).includes(type)) {
    throw ApiError.badRequest('"type" must be one of the redemption types', {
      allowed: REDEEM_TYPES,
    });
  }

  const wallet = await getOrCreateWallet(actor.customerId as string);
  const field = BALANCE_FIELD[type];
  const balance = (wallet as unknown as Record<string, number>)[field];

  if (balance < amount) {
    throw ApiError.badRequest(
      `Insufficient balance — you have ${balance} available and tried to redeem ${amount}`,
      { field, balance, requested: amount }
    );
  }

  await WalletModel().updateOne(
    { _id: wallet._id },
    { $inc: { [field]: -amount }, $set: { updatedAt: new Date() } }
  );

  await WalletTransactionModel().insertOne({
    customerId: wallet.customerId,
    type,
    amount: -amount,
    createdAt: new Date(),
  });

  const updated = await WalletModel().findOne({ _id: wallet._id });
  return sendSuccess(res, 200, "Wallet debited", { wallet: serialize(updated) });
}

/** GET /api/wallet/me/transactions — the append-only ledger, newest first. */
export async function listTransactions(
  firebaseUid: string | undefined,
  query: Record<string, unknown>,
  res: Response
) {
  const actor = await requireCustomerActor(firebaseUid);
  const pagination = getPagination(query);

  const transactions = WalletTransactionModel();
  const filter = { customerId: new ObjectId(actor.customerId as string) };

  const [docs, total] = await Promise.all([
    transactions
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .toArray(),
    transactions.countDocuments(filter),
  ]);

  return sendPaginated(
    res,
    "Wallet transactions retrieved",
    serializeMany(docs),
    total,
    pagination
  );
}

export { getOrCreateWallet };
export default { getMyWallet, topupWallet, redeemFromWallet, listTransactions };
