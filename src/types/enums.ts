export enum Role {
  ADMIN = "admin",
  OWNER = "owner",
  STAFF = "staff",
  CUSTOMER = "customer",
}

export enum BookingStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  ATTENDED = "attended",
  CANCELLED = "cancelled",
  LATE_CANCEL = "late_cancel",
  NO_SHOW = "no_show",
}

export enum PaymentMethod {
  WALLET = "wallet",
  CARD = "card",
  APPLE_PAY = "apple_pay",
  GOOGLE_PAY = "google_pay",
  GIFT_CARD = "gift_card",
  LOYALTY_POINTS = "loyalty_points",
  PACKAGE_SESSION = "package_session",
}

export enum VerificationStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

export enum StaffPermissionLevel {
  VIEW_ONLY = "view_only",
  STANDARD = "standard",
  MANAGER = "manager",
}

export enum PromotionType {
  HAPPY_HOUR = "happy_hour",
  LAST_MINUTE_DEAL = "last_minute_deal",
  NEW_CUSTOMER = "new_customer",
  RETURNING_CUSTOMER = "returning_customer",
  BIRTHDAY = "birthday",
  FLASH_SALE = "flash_sale",
  QUIET_DAY = "quiet_day",
}

export enum WaitlistStatus {
  WAITING = "waiting",
  NOTIFIED = "notified",
  BOOKED = "booked",
  EXPIRED = "expired",
}

export enum DisputeStatus {
  OPEN = "open",
  UNDER_REVIEW = "under_review",
  RESOLVED = "resolved",
  REJECTED = "rejected",
}

export enum WalletTransactionType {
  LOYALTY_EARN = "loyalty_earn",
  LOYALTY_REDEEM = "loyalty_redeem",
  GIFT_CARD_TOPUP = "gift_card_topup",
  GIFT_CARD_REDEEM = "gift_card_redeem",
  REFERRAL_CREDIT = "referral_credit",
  PACKAGE_PURCHASE = "package_purchase",
  PACKAGE_USE = "package_use",
}

/** Direction of a chat message. Stored on Message.senderRole. */
export enum MessageSenderRole {
  CUSTOMER = "customer",
  BUSINESS = "business",
}

/** Which side of the platform created a Promotion. Stored on Promotion.createdBy. */
export enum PromotionCreatedBy {
  OWNER = "owner",
  ADMIN = "admin",
}

/** Free-text customer preference. Kept as a closed set so it can be filtered. */
export enum GenderPreference {
  MALE = "male",
  FEMALE = "female",
  NO_PREFERENCE = "no_preference",
}
