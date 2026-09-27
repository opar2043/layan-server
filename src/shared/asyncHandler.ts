import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so a rejected promise is forwarded to next(err)
 * and lands in the global errorHandler. Applied in every route file, which is
 * why no controller function contains its own try/catch.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;
