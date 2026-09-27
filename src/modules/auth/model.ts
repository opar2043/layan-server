import { COLLECTIONS, getCollection } from "../../shared/db";
import { Document } from "mongodb";

/**
 * The ONLY model in the auth module. Owner credentials live on the Business
 * document (an owner IS the business) and staff credentials live on the Staff
 * document, so this collection is reserved for platform administrators.
 */
export interface IAdmin extends Document {
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export const AdminModel = () => getCollection<IAdmin>(COLLECTIONS.ADMINS);

export default AdminModel;
