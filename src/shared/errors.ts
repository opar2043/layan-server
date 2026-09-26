export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "bad_request", message, details);
  }

  static unauthorized(message = "Authentication token required"): ApiError {
    return new ApiError(401, "unauthorized", message);
  }

  static forbidden(message = "Not authorized", details?: unknown): ApiError {
    return new ApiError(403, "forbidden", message, details);
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(404, "not_found", message);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, "conflict", message, details);
  }

  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, "unprocessable", message, details);
  }

  static internal(message = "Internal server error"): ApiError {
    return new ApiError(500, "internal", message);
  }
}
