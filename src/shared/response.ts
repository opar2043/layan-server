import type { Response } from "express";

export function sendSuccess(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

export function sendError(
  res: Response,
  status: number,
  message: string,
  code = "error",
  details?: unknown,
): Response {
  const body: Record<string, unknown> = { success: false, code, message };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

/** `{ data, page, pageSize, total, totalPages }` — the shape every list endpoint returns. */
export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
