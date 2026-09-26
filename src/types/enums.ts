export const UserRole = {
  CUSTOMER: "customer",
  BUSINESS_OWNER: "business_owner",
  STAFF: "staff",
  ADMIN: "admin",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const USER_ROLES: readonly UserRole[] = Object.values(UserRole);

export const StaffRole = {
  OWNER: "owner",
  MANAGER: "manager",
  STYLIST: "stylist",
} as const;
export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole];
export const STAFF_ROLES: readonly StaffRole[] = Object.values(StaffRole);

export const PermissionFlag = {
  VIEW_FINANCIALS: "viewFinancials",
  VIEW_CUSTOMER_DATA: "viewCustomerData",
  MANAGE_CALENDAR: "manageCalendar",
  MANAGE_STAFF: "manageStaff",
  MANAGE_INVENTORY: "manageInventory",
  PROCESS_REFUNDS: "processRefunds",
} as const;
export type PermissionFlag = (typeof PermissionFlag)[keyof typeof PermissionFlag];
export const PERMISSION_FLAGS: readonly PermissionFlag[] = Object.values(PermissionFlag);

export const BookingStatus = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  ATTENDED: "attended",
  LATE_CANCEL: "late_cancel",
  NO_SHOW: "no_show",
  CANCELLED: "cancelled",
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

/** Statuses that still occupy the staff member's calendar slot. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

/** Statuses that a customer is allowed to cancel/reschedule from. */
export const CUSTOMER_MUTABLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

export const PaymentMethod = {
  WALLET: "wallet",
  SAVED_CARD: "saved_card",
  CARD: "card",
  APPLE_PAY: "apple_pay",
  GOOGLE_PAY: "google_pay",
  GIFT_CARD: "gift_card",
  LOYALTY_POINTS: "loyalty_points",
  PACKAGE_SESSION: "package_session",
  MEMBERSHIP: "membership",
  CASH: "cash",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const PAYMENT_METHODS: readonly PaymentMethod[] = Object.values(PaymentMethod);

export const PaymentType = {
  DEPOSIT: "deposit",
  BALANCE: "balance",
  TIP: "tip",
  PRODUCT: "product",
  REFUND: "refund",
} as const;
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

export const DiscountType = {
  PERCENTAGE: "percentage",
  FIXED: "fixed",
} as const;
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

export const PromotionType = {
  QUIET_DAY_DISCOUNT: "quiet_day_discount",
  LAST_MINUTE: "last_minute",
} as const;
export type PromotionType = (typeof PromotionType)[keyof typeof PromotionType];

export const FavouriteTargetType = {
  BUSINESS: "business",
  STAFF: "staff",
  SERVICE: "service",
  PORTFOLIO_ITEM: "portfolio_item",
} as const;
export type FavouriteTargetType = (typeof FavouriteTargetType)[keyof typeof FavouriteTargetType];

/** Badges that only the nightly compute job may write. */
export const COMPUTED_BADGE_KEYS = [
  "layan_top_professional",
  "highly_rebooked",
  "fast_responder",
  "instant_book_enabled",
] as const;
export type ComputedBadgeKey = (typeof COMPUTED_BADGE_KEYS)[number];

/** Badges that only an admin may grant, via the verification workflow. */
export const ADMIN_GRANTED_BADGE_KEYS = ["identity_verified", "business_verified"] as const;
export type AdminGrantedBadgeKey = (typeof ADMIN_GRANTED_BADGE_KEYS)[number];

/** Fields a client may never set directly on a resource. */
export const SERVER_OWNED_FIELDS = [
  "isVerifiedBooking",
  "badges",
  "businessScore",
  "insights",
  "ratingSummary",
  "statusHistory",
  "policySnapshot",
  "slotKey",
  "slotActive",
  "_id",
] as const;
