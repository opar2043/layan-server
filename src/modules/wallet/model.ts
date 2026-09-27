import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { WalletTransactionType } from "../../types/enums";

/** Pre-paid session block, e.g. 3 remaining manicures at one business. */
export interface PackageSession {
  businessId: Document["_id"];
  serviceId: Document["_id"];
  sessionsLeft: number;
}

/** A customer's balances. Created lazily on the first wallet read. */
export interface IWallet extends Document {
  customerId: Document["_id"];
  loyaltyPoints: number;
  giftCardBalance: number;
  packageSessions: PackageSession[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Append-only ledger. Rows are never updated or deleted — the wallet balance is the
 * sum of this history, so the transaction log is the audit trail.
 */
export interface IWalletTransaction extends Document {
  customerId: Document["_id"];
  type: WalletTransactionType;
  /** Signed: positive credits the balance, negative debits it. */
  amount: number;
  note?: string;
  createdAt: Date;
}

export const WalletModel = () => getCollection<IWallet>(COLLECTIONS.WALLETS);

export const WalletTransactionModel = () =>
  getCollection<IWalletTransaction>(COLLECTIONS.WALLET_TRANSACTIONS);

/** Transaction types that may be applied through the top-up endpoint. */
export const TOPUP_TYPES = [
  WalletTransactionType.LOYALTY_EARN,
  WalletTransactionType.REFERRAL_CREDIT,
  WalletTransactionType.GIFT_CARD_TOPUP,
] as const;

/** Transaction types that may be applied through the redeem endpoint. */
export const REDEEM_TYPES = [
  WalletTransactionType.LOYALTY_REDEEM,
  WalletTransactionType.GIFT_CARD_REDEEM,
] as const;

/** Which balance field each transaction type moves. */
export const BALANCE_FIELD: Record<string, "loyaltyPoints" | "giftCardBalance"> = {
  [WalletTransactionType.LOYALTY_EARN]: "loyaltyPoints",
  [WalletTransactionType.LOYALTY_REDEEM]: "loyaltyPoints",
  [WalletTransactionType.REFERRAL_CREDIT]: "giftCardBalance",
  [WalletTransactionType.GIFT_CARD_TOPUP]: "giftCardBalance",
  [WalletTransactionType.GIFT_CARD_REDEEM]: "giftCardBalance",
  [WalletTransactionType.PACKAGE_PURCHASE]: "giftCardBalance",
  [WalletTransactionType.PACKAGE_USE]: "giftCardBalance",
};

export default WalletModel;
