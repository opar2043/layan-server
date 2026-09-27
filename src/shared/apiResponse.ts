import { Response } from "express";

/**
 * The ONLY way a success response leaves this server.
 * Shape is fixed: { success: true, message, data }.
 */
export function sendSuccess<T>(
  res: Response,
  statusCode: number,
  message: string,
  data: T
): Response {
  return res.status(statusCode).json({ success: true, message, data });
}

export default sendSuccess;
