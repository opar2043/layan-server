import { JwtPayload } from "../types";

/**
 * Request augmentation. With no ODM in the pipeline there is no `req.user` to lean
 * on, so the middlewares below attach exactly two things:
 *   - `req.auth`        -> decoded JWT, for Owner / Staff / Admin
 *   - `req.firebaseUid` -> customer identity, for Firebase-authenticated customers
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: JwtPayload;
      firebaseUid?: string;
    }
  }
}

export {};
