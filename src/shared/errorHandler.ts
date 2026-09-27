import { NextFunction, Request, Response } from "express";
import { MongoServerError } from "mongodb";
import { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";
import { ApiError } from "./apiError";

/** MongoDB duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/** Catch-all 404 for any route that no router claimed. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * The single global error middleware. Registered LAST in app.ts.
 *
 * Since this project uses the native MongoDB driver instead of Mongoose there is
 * no `mongoose.Error.ValidationError` to branch on — the equivalent is handled by
 * shared/validate.ts, which throws ApiError.badRequest. Driver-level duplicate key
 * (code 11000) is still mapped to 409 here so no raw driver object escapes.
 *
 * Nothing below ever sends a stack trace to the client in production.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // 1. Our own operational errors.
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.errors !== undefined ? { errors: err.errors } : {}),
    });
    return;
  }

  // 2. Duplicate key -> 409.
  if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
    const field = Object.keys(err.keyValue ?? {})[0] ?? "field";
    res.status(409).json({
      success: false,
      message: `Duplicate value for "${field}" — a record with that value already exists`,
      errors: err.keyValue,
    });
    return;
  }

  // 3. Malformed ObjectId passed into a query.
  if (err instanceof MongoServerError || err instanceof Error) {
    if (err.name === "BSONError" || err.name === "MongoInvalidArgumentError") {
      res.status(400).json({ success: false, message: "Malformed identifier" });
      return;
    }
  }

  // 4. JWT failures -> 401.
  if (err instanceof TokenExpiredError) {
    res.status(401).json({ success: false, message: "Token has expired" });
    return;
  }
  if (err instanceof JsonWebTokenError) {
    res.status(401).json({ success: false, message: "Invalid authentication token" });
    return;
  }

  // 5. Bad JSON body from express.json().
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ success: false, message: "Malformed JSON payload" });
    return;
  }

  // 6. Anything unanticipated: log server-side, return a generic message.
  // eslint-disable-next-line no-console
  console.error("[error]", err);
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
}

export default { notFoundHandler, errorHandler };
