import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireAuth, requireRole } from "../../shared/auth.middleware";
import { identifyAny, resolveActor } from "../../shared/identify.middleware";
import { ApiError } from "../../shared/apiError";
import { Role } from "../../types/enums";
import { findCustomerIdByFirebaseUid } from "../users/users";
import { listMessages, listThreads, sendMessage } from "./messages";

const router = Router();

/** POST /api/messages — customer or business; identity is derived from the credential. */
router.post(
  "/",
  identifyAny,
  asyncHandler(async (req, res) => {
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return sendMessage(req.body as Record<string, unknown>, res, actor);
  })
);

/**
 * GET /api/messages/threads — registered BEFORE "/" so the literal path is not
 * captured as a query-string conversation filter.
 */
router.get(
  "/threads",
  requireAuth,
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return listThreads(res, actor);
  })
);

/** GET /api/messages — customer passes ?businessId=, business passes ?customerId=. */
router.get(
  "/",
  identifyAny,
  asyncHandler(async (req, res) => {
    const actor = await resolveActor(req, findCustomerIdByFirebaseUid);
    return listMessages(req.query as Record<string, unknown>, res, actor);
  })
);

export default router;
