import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document, ObjectId } from "mongodb";
import { GenderPreference } from "../../types/enums";

/** Customer geo location, stored only to rank nearby businesses. */
export interface UserLocation {
  city: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Customer profile. There is deliberately NO passwordHash field: customers are
 * authenticated by Firebase in the frontend and identified here by `firebaseUid`.
 */
export interface IUser extends Document {
  firebaseUid: string;
  name: string;
  email: string;
  phone?: string;
  genderPreference?: GenderPreference;
  location?: UserLocation;
  favouriteCategories: string[];
  /** Stored as ObjectIds; serialised to hex strings on the way out. */
  favouriteBusinessIds: ObjectId[];
  /** Unique code this customer shares to refer friends. */
  referralCode: string;
  /** Referral code of the customer who referred them, if any. */
  referredBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const UserModel = () => getCollection<IUser>(COLLECTIONS.USERS);

/** Fields a customer may change on their own profile. */
export const CUSTOMER_EDITABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "genderPreference",
  "location",
  "favouriteCategories",
] as const;

export default UserModel;
