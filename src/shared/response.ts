import type { Response } from "express";

export function sendSuccess(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

export function sendError(res: Response, status: number, message: string): Response {
  return res.status(status).json({ success: false, message });
}