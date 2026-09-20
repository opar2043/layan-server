enum userRole  {
  OWNER = "owner",
  STAFF = "staff",
  CUSTOMER = "customer",
  ADMIN = "admin"
}
export interface AppUser {
  _id: string;
  email: string;
  phone: string;
  password_hash: string;
  user_type: userRole;
  created_at: string;
}

export type CancellationFeeType = "percentage" | "fixed";

export interface CancellationPolicy {
  window_hours: number;
  fee_type: CancellationFeeType;
  fee_value: number;
}

export type VerificationStatus = "business" | "identity" | string;

export interface Business {
  _id: string;
  owner_user_id: string;
  legal_name: string;
  display_name: string;
  slug: string;
  category: string;
  description: string;
  cover_image_url: string;
  profile_image_url: string;
  cancellation_policy: CancellationPolicy;
  verification_status: VerificationStatus;
  business_score: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface OpeningTime {
  open: string;
  close: string;
}

export type OpeningHours = Record<Weekday, OpeningTime[]>;

export interface Location {
  _id: string;
  business_id: string;
  name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  postcode: string;
  country: string;
  lat: number;
  lng: number;
  opening_hours: OpeningHours;
  mobile_service_radius_km: number;
  is_active: boolean;
  created_at: string;
}

export type GenderPreference = "any" | "male" | "female";

export interface Customer {
  _id: string;
  first_name: string;
  last_name: string;
  gender_pref: GenderPreference;
  marketing_opt_in: boolean;
  created_at: string;
}

export interface StaffPermissions {
  can_manage_bookings: boolean;
}

export interface Staff {
  _id: string;
  user_id: string;
  business_id: string;
  location_id: string;
  display_name: string;
  role: string;
  commission_pct: number;
  permissions: StaffPermissions;
  is_active: boolean;
}

export interface StaffAvailability {
  _id: string;
  staff_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface StaffTimeOff {
  _id: string;
  staff_id: string;
  start_at: string;
  end_at: string;
  reason: string;
}

export interface ServiceCategory {
  _id: string;
  name: string;
}

export interface Service {
  _id: string;
  business_id: string;
  category_id: string;
  name: string;
  description: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  base_price_minor: number;
  lead_time_hours: number;
  is_instant_book: boolean;
  is_active: boolean;
}

export interface StaffService {
  _id: string;
  staff_id: string;
  service_id: string;
  price_override_minor: number;
  duration_override_minutes: number;
}

export type MediaType = "image" | "video";

export interface PortfolioMedia {
  _id: string;
  business_id: string;
  staff_id: string;
  service_id: string;
  media_url: string;
  media_type: MediaType;
  before_after_pair_url: string | null;
  tags: string[];
  created_at: string;
}

export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "attended"
  | "cancelled"
  | "no_show"
  | string;

export type SourceChannel = "marketplace" | string;

export interface Appointment {
  _id: string;
  business_id: string;
  location_id: string;
  staff_id: string;
  customer_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source_channel: SourceChannel;
  total_price_minor: number;
  deposit_required_minor: number;
  recurrence_rule: string | null;
  group_booking_id: string | null;
  notes: string;
  created_at: string;
}

export interface AppointmentService {
  _id: string;
  appointment_id: string;
  service_id: string;
  price_minor: number;
  duration_minutes: number;
}

export interface AppointmentStatusHistory {
  _id: string;
  appointment_id: string;
  old_status: AppointmentStatus;
  new_status: AppointmentStatus;
  changed_by: string;
  changed_at: string;
}

export type WaitlistStatus = "active" | "notified" | "booked" | string;

export interface DateRange {
  start: string;
  end: string;
}

export interface WaitlistEntry {
  _id: string;
  business_id: string;
  customer_id: string;
  service_id: string;
  staff_id: string;
  preferred_date_range: DateRange;
  preferred_time_range: DateRange;
  status: WaitlistStatus;
  created_at: string;
}

export interface LastMinuteSlot {
  _id: string;
  business_id: string;
  staff_id: string;
  service_id: string;
  start_at: string;
  discount_pct: number;
  is_booked: boolean;
}

export type PaymentType = "deposit" | "full_payment";

export type PaymentStatus = "succeeded" | "pending" | "failed" | "refunded" | string;

export interface Payment {
  _id: string;
  appointment_id: string;
  business_id: string;
  customer_id: string;
  psp_payment_intent_id: string;
  amount_minor: number;
  platform_fee_minor: number;
  tip_minor: number;
  type: PaymentType;
  status: PaymentStatus;
  created_at: string;
}

export interface PaymentEvent {
  _id: string;
  payment_id: string;
  event_type: string;
  raw_payload: Record<string, unknown>;
  received_at: string;
}

export interface CustomerWallet {
  _id: string;
  customer_id: string;
  balance_minor: number;
}

export type WalletTransactionSource = "refund_credit" | "referral_credit" | "loyalty_redeem" | string;

export interface WalletTransaction {
  _id: string;
  customer_id: string;
  amount_minor: number;
  source: WalletTransactionSource;
  reference_id: string;
  created_at: string;
}

export interface GiftCard {
  _id: string;
  business_id: string | null;
  code: string;
  initial_value_minor: number;
  remaining_value_minor: number;
  purchased_by: string;
  recipient_customer_id: string;
  delivery_at: string;
  expires_at: string;
}

export type BillingInterval = "monthly" | "yearly" | string;

export interface IncludedServices {
  service_ids: string[];
  sessions: number;
}

export interface MembershipPlan {
  _id: string;
  business_id: string;
  name: string;
  price_minor: number;
  billing_interval: BillingInterval;
  included_services: IncludedServices;
  discount_pct: number;
}

export type MembershipStatus = "active" | "paused" | "cancelled" | string;

export interface CustomerMembership {
  _id: string;
  customer_id: string;
  plan_id: string;
  status: MembershipStatus;
  psp_subscription_id: string;
  current_period_end: string;
}

export interface ServicePackage {
  _id: string;
  business_id: string;
  service_id: string;
  name: string;
  session_count: number;
  price_minor: number;
}

export interface CustomerPackage {
  _id: string;
  customer_id: string;
  package_id: string;
  sessions_remaining: number;
  purchased_at: string;
  expires_at: string;
}

export interface InventoryItem {
  _id: string;
  business_id: string;
  location_id: string;
  sku: string;
  name: string;
  supplier: string;
  cost_minor: number;
  sell_price_minor: number;
  quantity: number;
  low_stock_threshold: number;
}

export type StockMovementReason = "used_in_service" | "sold" | string;

export interface StockMovement {
  _id: string;
  inventory_item_id: string;
  delta: number;
  reason: StockMovementReason;
  reference_id: string;
  created_at: string;
}

export interface CustomerBusinessProfile {
  _id: string;
  customer_id: string;
  business_id: string;
  total_spend_minor: number;
  visit_count: number;
  avg_spend_minor: number;
  last_visit_at: string;
  no_show_count: number;
  cancellation_count: number;
  predicted_rebook_cycle_days: number;
  notes: string;
  allergies: string | null;
  marketing_permission: boolean;
}

export type FieldType = "text" | "number" | "select" | "boolean" | string;

export interface FormField {
  name: string;
  type: FieldType;
}

export interface FormSchema {
  fields: FormField[];
}

export interface ConsultationFormTemplate {
  _id: string;
  business_id: string;
  name: string;
  schema: FormSchema;
}

export interface ConsultationFormSubmission {
  _id: string;
  template_id: string;
  customer_id: string;
  appointment_id: string;
  answers: Record<string, string>;
  signature_url: string;
  submitted_at: string;
}

export interface RewardThreshold {
  points: number;
  reward_minor: number;
}

export interface LoyaltyRules {
  points_per_pound: number;
  reward_thresholds: RewardThreshold[];
}

export interface LoyaltyProgram {
  _id: string;
  business_id: string;
  rules: LoyaltyRules;
}

export interface LoyaltyAccount {
  _id: string;
  customer_id: string;
  business_id: string;
  points_balance: number;
}

export type LoyaltyTransactionReason = "appointment_completed" | string;

export interface LoyaltyTransaction {
  _id: string;
  customer_id: string;
  business_id: string;
  points_delta: number;
  reason: LoyaltyTransactionReason;
  reference_id: string;
  created_at: string;
}

export interface Referral {
  _id: string;
  referrer_customer_id: string;
  business_id: string | null;
  code: string;
  reward_referrer_minor: number;
  reward_referee_minor: number;
}

export interface ReferralRedemption {
  _id: string;
  referral_id: string;
  referee_customer_id: string;
  qualifying_appointment_id: string;
  redeemed_at: string;
}

export type FavouriteTargetType = "business" | "staff" | "service";

export interface CustomerFavourite {
  _id: string;
  customer_id: string;
  target_type: FavouriteTargetType;
  target_id: string;
  created_at: string;
}

export interface MessageThread {
  _id: string;
  business_id: string;
  customer_id: string;
  appointment_id: string;
}

export type MessageSenderType = "customer" | "business" | "system";

export interface Message {
  _id: string;
  thread_id: string;
  sender_type: MessageSenderType;
  sender_id: string | null;
  body: string;
  image_url: string | null;
  sent_at: string;
}

export interface Review {
  _id: string;
  appointment_id: string;
  business_id: string;
  customer_id: string;
  overall_rating: number;
  service_rating: number;
  cleanliness_rating: number;
  value_rating: number;
  professionalism_rating: number;
  punctuality_rating: number;
  comment: string;
  photo_urls: string[];
  business_reply: string;
  is_verified_booking: boolean;
  created_at: string;
}

export type BadgeType = "verified" | "identity_verified" | "popular" | string;

export interface BusinessBadge {
  _id: string;
  business_id: string;
  badge_type: BadgeType;
  awarded_at: string;
}

export type FlaggableEntityType = "customer" | "payment" | "business" | string;

export type FlagType = "multiple_accounts" | "velocity_check" | "review_pattern" | string;

export type FlagSeverity = "low" | "medium" | "high";

export type FlagStatus = "dismissed" | "investigating" | "open" | string;

export interface FraudFlag {
  _id: string;
  entity_type: FlaggableEntityType;
  entity_id: string;
  flag_type: FlagType;
  severity: FlagSeverity;
  details: Record<string, unknown>;
  status: FlagStatus;
  created_at: string;
}

export type DisputeStatus = "open" | "investigating" | "resolved" | string;

export interface Dispute {
  _id: string;
  payment_id: string;
  raised_by: string;
  reason: string;
  status: DisputeStatus;
  resolution: string | null;
  created_at: string;
}

export type PromotionType = "happy_hour" | "new_customer" | "flash_sale" | string;

export type PromotionRules =
  | { weekdays: number[]; hours: string[] }
  | { first_visit: boolean }
  | { max_redemptions: number }
  | Record<string, unknown>;

export interface Promotion {
  _id: string;
  business_id: string;
  type: PromotionType;
  discount_pct: number;
  rules: PromotionRules;
  active_from: string;
  active_to: string;
}

export interface PromotionRedemption {
  _id: string;
  promotion_id: string;
  appointment_id: string;
  discount_applied_minor: number;
}

export type CampaignChannel = "sms" | "email" | "push" | string;

export type CampaignStatus = "scheduled" | "draft" | "sent" | string;

export interface CampaignSegmentDefinition {
  visit_count_gte?: number;
  new_customer?: boolean;
  marketing_permission?: boolean;
  [key: string]: unknown;
}

export interface MarketingCampaign {
  _id: string;
  business_id: string;
  channel: CampaignChannel;
  template: string;
  segment_definition: CampaignSegmentDefinition;
  status: CampaignStatus;
  scheduled_at: string | null;
  is_ai_generated: boolean;
}

export type RecipientStatus = "queued" | "sent" | "failed" | string;

export interface CampaignRecipient {
  _id: string;
  campaign_id: string;
  customer_id: string;
  status: RecipientStatus;
  sent_at: string | null;
}

export interface AdminActionLog {
  _id: string;
  admin_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface SeedData {
  app_user: AppUser[];
  business: Business[];
  location: Location[];
  customer: Customer[];
  staff: Staff[];
  staff_availability: StaffAvailability[];
  staff_time_off: StaffTimeOff[];
  service_category: ServiceCategory[];
  service: Service[];
  staff_service: StaffService[];
  portfolio_media: PortfolioMedia[];
  appointment: Appointment[];
  appointment_service: AppointmentService[];
  appointment_status_history: AppointmentStatusHistory[];
  waitlist_entry: WaitlistEntry[];
  last_minute_slot: LastMinuteSlot[];
  payment: Payment[];
  payment_event: PaymentEvent[];
  customer_wallet: CustomerWallet[];
  wallet_transaction: WalletTransaction[];
  gift_card: GiftCard[];
  membership_plan: MembershipPlan[];
  customer_membership: CustomerMembership[];
  service_package: ServicePackage[];
  customer_package: CustomerPackage[];
  inventory_item: InventoryItem[];
  stock_movement: StockMovement[];
  customer_business_profile: CustomerBusinessProfile[];
  consultation_form_template: ConsultationFormTemplate[];
  consultation_form_submission: ConsultationFormSubmission[];
  loyalty_program: LoyaltyProgram[];
  loyalty_account: LoyaltyAccount[];
  loyalty_transaction: LoyaltyTransaction[];
  referral: Referral[];
  referral_redemption: ReferralRedemption[];
  customer_favourite: CustomerFavourite[];
  message_thread: MessageThread[];
  message: Message[];
  review: Review[];
  business_badge: BusinessBadge[];
  fraud_flag: FraudFlag[];
  dispute: Dispute[];
  promotion: Promotion[];
  promotion_redemption: PromotionRedemption[];
  marketing_campaign: MarketingCampaign[];
  campaign_recipient: CampaignRecipient[];
  admin_action_log: AdminActionLog[];
}