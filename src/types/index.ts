import { Role } from "./enums";

/** Decoded JWT body attached to `req.auth` by requireAuth. */
export interface JwtPayload {
  id: string;
  role: Role;
  email: string;
  /** Present for OWNER (own business) and STAFF (employer's business). Absent for ADMIN. */
  businessId?: string;
  iat?: number;
  exp?: number;
}

/** Uniform success envelope returned by sendSuccess(). */
export interface ApiSuccessBody<T = unknown> {
  success: true;
  message: string;
  data: T;
}

/** Uniform error envelope produced by the global error handler. */
export interface ApiErrorBody {
  success: false;
  message: string;
  errors?: unknown;
}

/** Standard shape for every paginated list endpoint. */
export interface PaginatedData<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/** Fields every module document carries, mirroring the sample payload. */
export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}
