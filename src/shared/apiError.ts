/**
 * Custom error type. Every failure in the app is thrown as an ApiError and caught
 * by the single global errorHandler, so no route ever needs its own try/catch and
 * no raw stack trace ever reaches the client.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly errors?: unknown;
  public readonly isOperational = true;

  constructor(statusCode: number, message: string, errors?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = "Bad request", errors?: unknown): ApiError {
    return new ApiError(400, message, errors);
  }

  static unauthorized(message = "Authentication required"): ApiError {
    return new ApiError(401, message);
  }

  static forbidden(message = "You do not have permission to perform this action"): ApiError {
    return new ApiError(403, message);
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(404, message);
  }

  static conflict(message = "Resource already exists", errors?: unknown): ApiError {
    return new ApiError(409, message, errors);
  }

  static unprocessable(message = "Unprocessable request", errors?: unknown): ApiError {
    return new ApiError(422, message, errors);
  }

  static tooManyRequests(message = "Too many requests, please try again later"): ApiError {
    return new ApiError(429, message);
  }

  static internal(message = "Internal server error"): ApiError {
    return new ApiError(500, message);
  }
}

export default ApiError;
