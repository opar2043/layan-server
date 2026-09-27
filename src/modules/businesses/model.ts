import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";
import { VerificationStatus } from "../../types/enums";

/**
 * Geo coordinates use `latitude` / `longitude` (not `lat` / `lng`) to match the
 * shapes the mobile clients already send and the sample payload in data/data.json.
 */
export interface BusinessLocation {
  address: string;
  city: string;
  latitude?: number;
  longitude?: number;
  /** 0 = no mobile service; >0 = travels up to N km to the customer. */
  mobileServiceRadiusKm: number;
}

export interface IBusiness extends Document {
  ownerName: string;
  email: string;
  passwordHash: string;
  businessName: string;
  category: string;
  description?: string;
  location: BusinessLocation;
  openingHours?: string;
  coverImage?: string;
  profileImage?: string;
  portfolio: string[];
  amenities: string[];
  cancellationPolicy?: string;
  instantBookEnabled: boolean;
  verificationStatus: VerificationStatus;
  isBusinessVerified: boolean;
  isIdentityVerified: boolean;
  badges: string[];
  /** Self-reference used when several branches roll up to one master account. */
  masterAccountId?: string | null;
  bookingUrl?: string;
  /** 0-100. */
  businessScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export const BusinessModel = () => getCollection<IBusiness>(COLLECTIONS.BUSINESSES);

/**
 * Fields a business owner is allowed to change on themselves. Deliberately excludes
 * passwordHash, verificationStatus, the is*Verified flags, badges and businessScore,
 * all of which are admin-controlled.
 */
export const OWNER_EDITABLE_FIELDS = [
  "ownerName",
  "businessName",
  "category",
  "description",
  "openingHours",
  "coverImage",
  "profileImage",
  "portfolio",
  "amenities",
  "cancellationPolicy",
  "instantBookEnabled",
  "bookingUrl",
  "location",
] as const;

export default BusinessModel;
