import type { Collection } from "mongodb";
import type { AppDocument } from "../shared/db";

export type { AppDocument };
import type {
  BookingStatus,
  DiscountType,
  PermissionFlag,
  StaffRole,
  UserRole,
} from "./enums";

/** `[lng, lat]` GeoJSON point, or `null`. */
export type GeoPoint = [number, number] | null;

export interface MarketingConsent {
  sms: boolean;
  email: boolean;
  push: boolean;
}

export interface UserDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  role: UserRole;
  adminRole?: string;
  email: string;
  phone?: string | null;
  passwordHash: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  status: "active" | "suspended" | "restricted" | "deleted";
  emailVerified?: boolean;
  phoneVerified?: boolean;
  marketingConsent?: MarketingConsent;
  deviceTokens?: Array<{ token: string; platform: string }>;
  homeLocation?: { type: "Point"; coordinates: number[] } | null;
  preferences?: {
    maxDistanceKm?: number;
    providerGender?: string;
    favouriteCategoryIds?: string[];
    currency?: string;
  };
  referralCode?: string | null;
  lastLoginAt?: string | null;
}

export interface StaffPermissions {
  viewFinancials: boolean;
  viewCustomerData: boolean;
  manageCalendar: boolean;
  manageStaff: boolean;
  manageInventory: boolean;
  processRefunds: boolean;
}

export interface StaffDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  locationIds?: string[];
  userId: string;
  displayName: string;
  title?: string | null;
  role: StaffRole;
  avatarUrl?: string | null;
  bio?: string | null;
  permissions: StaffPermissions;
  workingHours?: Record<string, Array<[string, string]>>;
  serviceIds?: string[];
  commission?: { type: "none" | "percentage" | "fixed"; value: number };
  calendarColor?: string;
  calendarSync?: { provider: string | null; calendarId: string | null; enabled: boolean };
  ratingSummary?: { average: number; count: number };
  bookable?: boolean;
  status: "invited" | "active" | "suspended";
  inviteEmail?: string | null;
}

export interface CancellationPolicy {
  freeCancelHours: number;
  rescheduleWindowHours: number;
  lateCancelDepositForfeitPercent: number;
  noShowDepositForfeitPercent: number;
}

export interface BusinessDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  name: string;
  slug: string;
  type: "business" | "solo_professional";
  description?: string;
  categoryIds?: string[];
  logoUrl?: string | null;
  coverUrl?: string | null;
  contact?: { email?: string; phone?: string; website?: string | null };
  social?: Record<string, string | null>;
  amenities?: string[];
  qualifications?: Array<{ title: string; year?: number }>;
  cancellationPolicy: CancellationPolicy;
  depositDefaults?: { type: DiscountType | "none"; value: number };
  faqs?: Array<{ key: string; question: string; answer: string }>;
  instantBook?: boolean;
  isMobileService?: boolean;
  mobileServiceRadiusKm?: number | null;
  instantSlotsEnabled?: boolean;
  bookingUrl?: string;
  channels?: Record<string, boolean>;
  ratingSummary?: { average: number; count: number; breakdown?: Record<string, number> };
  verification?: { identityVerified: boolean; businessVerified: boolean };
  badges?: string[];
  businessScore?: number;
  subscriptionId?: string | null;
  currency: string;
  timezone: string;
  status: "active" | "pending_verification" | "suspended";
  settings?: {
    autoInstantSlots?: boolean;
    reviewModerationThreshold?: number;
    loyaltyProgramId?: string | null;
  };
}

export interface LocationDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  name: string;
  isPrimary: boolean;
  address: {
    line1?: string | undefined;
    city?: string | undefined;
    postcode?: string | undefined;
    country?: string | undefined;
  };
  geo?: { type: "Point"; coordinates: number[] } | null | undefined;
  phone?: string | undefined;
  timezone: string;
  openingHours?: Record<string, Array<[string, string]>> | undefined;
  customHours?: Array<{
    date: string;
    open: string | null;
    close: string | null;
    closed: boolean;
  }> | undefined;
  amenities?: string[] | undefined;
  status: "active" | "inactive";
}

export interface ServiceDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  categoryId?: string | undefined;
  name: string;
  description?: string | undefined;
  durationMin: number;
  priceMinor: number;
  currency: string;
  bufferBeforeMin?: number | undefined;
  bufferAfterMin?: number | undefined;
  staffIds?: string[] | undefined;
  locationIds?: string[] | undefined;
  staffPricing?: Array<{ staffId: string; priceMinor: number }> | undefined;
  addOns?: Array<{ name: string; durationMin: number; priceMinor: number }> | undefined;
  depositRule?: { type: DiscountType | "none"; value: number } | undefined;
  instantBook?: boolean | undefined;
  homeService?: boolean | undefined;
  rebookCycleDays?: { min: number; max: number } | null | undefined;
  leadTimeMinutes?: number | undefined;
  maxAdvanceDays?: number | undefined;
  calendarColor?: string | null | undefined;
  tags?: string[] | undefined;
  requiresConsultationFormId?: string | null | undefined;
  isActive: boolean;
  sortOrder?: number | undefined;
}

export interface BookingItem {
  serviceId: string;
  name: string;
  durationMin: number;
  priceMinor: number;
  staffId: string;
}

export interface BookingDoc {
  _id: string;
  bookingRef: string;
  businessId: string;
  locationId: string;
  staffId: string;
  resourceId?: string | null;
  customerUserId: string;
  customerId: string;
  source: string;
  isWalkIn: boolean;
  groupSize: number;
  seriesId?: string | null;
  recurrence?: unknown;
  items: BookingItem[];
  startAt: string;
  endAt: string;
  status: BookingStatus;
  pricing: {
    subtotalMinor: number;
    discountMinor: number;
    tipMinor: number;
    totalMinor: number;
    commissionMinor?: number;
  };
  deposit: {
    required: boolean;
    amountMinor: number;
    paymentId: string | null;
    status: string;
  };
  policySnapshot: CancellationPolicy;
  policyAgreedAt: string;
  promotionId?: string | null;
  instantSlotId?: string | null;
  orderId?: string | null;
  paymentIds?: string[];
  reviewId?: string | null;
  cancellation?: {
    by: "customer" | "business" | "admin";
    at: string;
    reason: string | null;
    isLate: boolean;
    feeRetainedMinor: number;
    refundedMinor: number;
  } | null;
  rescheduledFrom?: { startAt: string; endAt: string; at: string } | null;
  notes?: string | null;
  statusHistory: Array<{ status: BookingStatus; at: string; by: string }>;
  /** `${staffId}::${startAt}` — unique while `slotActive` is true. */
  slotKey?: string | null;
  slotActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  userId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  favouriteServiceId?: string | null;
  favouriteStaffId?: string | null;
  stats: {
    totalAppointments: number;
    lifetimeSpendMinor: number;
    avgSpendMinor: number;
    cancellations: number;
    noShows: number;
    lastVisitAt?: string | null;
    upcomingBookingId?: string | null;
  };
  /** Server-owned: recomputed nightly, never client-settable. */
  insights: {
    avgRebookIntervalDays: number | null;
    nextExpectedVisit: string | null;
    overdueDays: number;
    isOverdue: boolean;
    suggestedAction: string | null;
    segments: string[];
  };
  notes?: Array<{ text: string; by: string; at: string }>;
  allergies?: string[];
  tags?: string[];
  loyaltyPoints?: number;
  giftCardBalanceMinor?: number;
  membershipId?: string | null;
  marketingConsent?: MarketingConsent;
  beforeAfterImages?: string[];
  source?: string;
  isBlocked?: boolean;
}

export interface ReviewDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  bookingId: string;
  businessId: string;
  staffId: string;
  serviceId: string;
  customerUserId: string;
  ratings: Record<string, number>;
  comment?: string;
  photos?: string[];
  /** Always derived from `Booking.status === 'attended'`. Never client-settable. */
  isVerifiedBooking: boolean;
  businessReply?: { message: string; repliedAt: string; by: string } | null;
  status: "published" | "under_review" | "hidden";
  moderation?: { flagged: boolean; score: number; reason?: string };
}

export interface PaymentDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  bookingId?: string | null;
  orderId?: string | null;
  customerUserId: string;
  type: string;
  method: string;
  amountMinor: number;
  tipMinor: number;
  currency: string;
  provider: string;
  providerPaymentIntentId?: string | null;
  status: "requires_action" | "processing" | "succeeded" | "failed" | "refunded" | "partially_refunded";
  feeMinor: number;
  netMinor: number;
  refunds: Array<{
    refundId: string;
    amountMinor: number;
    reason: string;
    status: string;
    createdAt: string;
  }>;
  payoutId?: string | null;
  paidAt?: string | null;
}

export interface InstantSlotDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  locationId: string;
  staffId: string;
  serviceId: string;
  originalBookingId?: string | null;
  startAt: string;
  endAt: string;
  originalPriceMinor: number;
  discountedPriceMinor: number;
  promotionId?: string | null;
  autoPublished: boolean;
  status: "open" | "booked" | "expired" | "withdrawn";
  bookedBookingId?: string | null;
  publishedAt: string;
  expiresAt: string;
}

export interface AdminActionLogDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  at: string;
}

export interface BusinessScoreDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  period: string;
  score: number;
  components: Record<string, { value: number; weight: number }>;
  recommendations: Array<{ action: string; estimatedGain: number }>;
  computedAt: string;
}

export interface FraudFlagDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  type: string;
  severity: "low" | "medium" | "high";
  targetType: string;
  targetId: string;
  businessId?: string | null;
  signals: Array<Record<string, unknown>>;
  status: "open" | "investigating" | "restricted" | "dismissed" | "actioned";
  detectedBy: "system" | "admin";
  assignedTo?: string | null;
  actions?: Array<{ action: string; by: string; at: string; note?: string | null }> | undefined;
}

export interface BadgeAwardDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string | null;
  staffId?: string | null;
  badgeKey: string;
  criteria: Record<string, unknown>;
  awardedAt: string;
  validUntil: string;
  status: "active" | "expired" | "revoked";
}

export interface CategoryDoc extends AppDocument {
  name: string;
  slug: string;
  parentId: string | null;
  icon?: string;
  sortOrder?: number;
  isActive: boolean;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  bookingId: string;
  customerUserId: string;
  participants: Array<{ userId: string; role: "customer" | "business" }>;
  lastMessage: { text: string; senderId: string; at: string } | null;
  /** Keyed by user id: how many messages each participant has not read. */
  unread: Record<string, number>;
  status: "open" | "closed" | "archived";
}

export interface MessageDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  senderId: string;
  senderType: "customer" | "business" | "admin" | "system";
  type: string;
  body: string;
  attachments: string[];
  isAutoReply: boolean;
  faqKey: string | null;
  readBy: string[];
}

export interface ResourceDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  locationId: string;
  name: string;
  type: string;
  capacity: number;
  serviceIds?: string[];
  isActive: boolean;
}

export interface TimeOffDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  locationId: string | null;
  staffId: string | null;
  type: string;
  title: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  recurrence: { freq: string; byWeekday?: string[]; until?: string | null } | null;
  createdBy: string;
}

export interface WaitlistDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  locationId: string | null;
  customerUserId: string;
  serviceId: string;
  staffId: string | null;
  preferredDates: string[];
  preferredTimeRanges: Array<[string, string]>;
  notifyVia: string[];
  status: "active" | "notified" | "converted" | "expired" | "cancelled";
  notifiedAt: string | null;
  instantSlotId: string | null;
  bookingId: string | null;
  expiresAt: string;
}

export interface SavedCard {
  provider: string;
  providerPaymentMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export interface LoyaltyPointRow {
  businessId: string;
  points: number;
}

export interface WalletDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  currency: string;
  balances: {
    giftCardMinor: number;
    refundCreditMinor: number;
    referralCreditMinor: number;
  };
  loyaltyPoints: LoyaltyPointRow[];
  savedCards: SavedCard[];
}

export interface WalletLedgerEntry {
  entryId: string;
  userId: string;
  bucket: "giftCard" | "refundCredit" | "referralCredit";
  amountMinor: number;
  balanceAfterMinor: number;
  reason: string;
  refType: string;
  refId: string;
  createdBy: string;
  createdAt: string;
}

export interface PromotionDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  /** `null` marks a platform-wide promotion that every business can redeem. */
  businessId: string | null;
  type: string;
  name: string;
  discount: { type: "percentage" | "fixed" | "free_upgrade" | "free_addon"; value: number };
  rules: {
    daysOfWeek?: number[];
    startTime?: string;
    endTime?: string;
    minimumSpendMinor?: number;
    customerSegments?: string[];
  };
  serviceIds: string[];
  locationIds: string[];
  validFrom: string;
  validTo: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  stackable: boolean;
  status: "draft" | "active" | "paused" | "expired";
  createdBy: string;
}

export interface CustomerPackageDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  packageId: string;
  userId: string;
  customerId: string;
  sessionsTotal: number;
  sessionsRemaining: number;
  usage: Array<{ bookingId: string; usedAt: string }>;
  paymentId: string;
  status: "active" | "exhausted" | "expired" | "cancelled";
  expiresAt: string;
}

export interface CustomerMembershipDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  businessId: string;
  planId: string;
  userId: string;
  customerId: string;
  status: "active" | "paused" | "cancelled" | "expired";
  currentCycleStart: string;
  currentCycleEnd: string;
  usage: Array<{ serviceId: string; included: number; used: number }>;
  stripeSubscriptionId: string | null;
  nextBillingAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface DisputeDoc {
  _id: string;
  createdAt: string;
  updatedAt: string;
  type: "chargeback" | "customer_dispute";
  raisedBy: string;
  businessId: string;
  bookingId: string;
  paymentId: string;
  reason: string;
  evidence: Array<{ by: string; note: string; url: string }>;
  status: "open" | "under_review" | "resolved_buyer" | "resolved_merchant" | "closed";
  assignedTo: string | null;
  resolution: string | null;
  timeline: Array<{ at: string; event: string; by: string }>;
}

export interface CollectionMap {
  _id: string;
  users: Collection<UserDoc>;
  verificationRequests: Collection<AppDocument>;
  businesses: Collection<BusinessDoc>;
  locations: Collection<LocationDoc>;
  staff: Collection<StaffDoc>;
  categories: Collection<AppDocument>;
  services: Collection<ServiceDoc>;
  resources: Collection<AppDocument>;
  timeOffs: Collection<AppDocument>;
  bookings: Collection<BookingDoc>;
  waitlists: Collection<AppDocument>;
  instantSlots: Collection<InstantSlotDoc>;
  orders: Collection<AppDocument>;
  payments: Collection<PaymentDoc>;
  payouts: Collection<AppDocument>;
  wallets: Collection<AppDocument>;
  walletTransactions: Collection<AppDocument>;
  giftCards: Collection<AppDocument>;
  membershipPlans: Collection<AppDocument>;
  customerMemberships: Collection<AppDocument>;
  servicePackages: Collection<AppDocument>;
  customerPackages: Collection<AppDocument>;
  customers: Collection<CustomerDoc>;
  consultationForms: Collection<AppDocument>;
  consultationResponses: Collection<AppDocument>;
  loyaltyPrograms: Collection<AppDocument>;
  loyaltyTransactions: Collection<AppDocument>;
  referralCampaigns: Collection<AppDocument>;
  referrals: Collection<AppDocument>;
  promotions: Collection<AppDocument>;
  campaigns: Collection<AppDocument>;
  portfolioItems: Collection<AppDocument>;
  reviews: Collection<ReviewDoc>;
  favourites: Collection<AppDocument>;
  conversations: Collection<AppDocument>;
  messages: Collection<AppDocument>;
  notifications: Collection<AppDocument>;
  products: Collection<AppDocument>;
  businessScores: Collection<BusinessScoreDoc>;
  badgeAwards: Collection<BadgeAwardDoc>;
  fraudFlags: Collection<FraudFlagDoc>;
  disputes: Collection<AppDocument>;
  subscriptions: Collection<AppDocument>;
  importJobs: Collection<AppDocument>;
  userActivities: Collection<AppDocument>;
  adminActionLogs: Collection<AdminActionLogDoc>;
}

export type { PermissionFlag, UserRole, StaffRole, BookingStatus };
