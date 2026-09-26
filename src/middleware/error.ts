import type { NextFunction, Request, RequestHandler, Response } from "express";
import { MongoServerError } from "mongodb";
import { ApiError } from "../shared/errors";
import { sendError } from "../shared/response";

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

const DUPLICATE_KEY = 11000;

/** Terminal error middleware: the only place that turns a throw into a response. */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ApiError) {
    sendError(res, error.status, error.message, error.code, error.details);
    return;
  }

  if (error instanceof MongoServerError) {
    if (error.code === DUPLICATE_KEY) {
      const field = Object.keys(error.keyPattern ?? {})[0] ?? "value";
      sendError(
        res,
        409,
        field === "slotKey" || field === "resourceId"
          ? "That time slot was just taken. Please pick another."
          : `Duplicate ${field}`,
        "duplicate_key",
        { field },
      );
      return;
    }
    console.error("[mongo]", error.message);
    sendError(res, 500, "Database error");
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    sendError(res, 400, "Malformed JSON body", "bad_request");
    return;
  }

  console.error("[unhandled]", error);
  sendError(res, 500, "Internal server error");
}

export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, 404, "Endpoint not found", "not_found");
}
