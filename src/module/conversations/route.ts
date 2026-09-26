import { Router, type Request } from "express";
import { asyncHandler } from "../../middleware/error";
import { currentUser, requireAuth } from "../../auth/middleware";
import { sendSuccess } from "../../shared/response";
import { queryInt, requireObject } from "../../shared/utils";
import * as conversations from "./conversations";

/**
 * `/api/conversations` — one thread per booking, shared by the customer, the
 * stylist and the owner. All rules live in `conversations.ts`.
 */
const router = Router();

router.use(requireAuth);

const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

/** `GET /api/conversations` — threads the caller participates in. */
router.get(
  "/",
  asyncHandler(async (req: Request, res) => {
    const query = req.query as Record<string, unknown>;
    const page = queryInt(query, "page", 1, 1, 10_000);
    const pageSize = queryInt(query, "pageSize", 25, 1, 100);
    const result = await conversations.listConversations(currentUser(req).id, page, pageSize);
    return sendSuccess(res, {
      data: result.docs,
      page,
      pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / pageSize),
    });
  }),
);

/** `POST /api/conversations` — opens the single thread for a booking. */
router.post(
  "/",
  asyncHandler(async (req: Request, res) => {
    const result = await conversations.openConversation(currentUser(req).id, body(req));
    return sendSuccess(res, result.conversation, result.created ? 201 : 200);
  }),
);

/**
 * `GET /api/conversations/unread-count` — declared before `/:id` so the literal
 * path is not swallowed by the parameterised route.
 */
router.get(
  "/unread-count",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await conversations.unreadCount(currentUser(req).id)),
  ),
);

/** `GET /api/conversations/:id` — one thread with its messages. */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await conversations.getThread(currentUser(req).id, String(req.params.id))),
  ),
);

/** `POST /api/conversations/:id/messages` */
router.post(
  "/:id/messages",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(
      res,
      await conversations.postMessage(currentUser(req).id, String(req.params.id), body(req)),
      201,
    ),
  ),
);

/** `POST /api/conversations/:id/read` */
router.post(
  "/:id/read",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await conversations.markRead(currentUser(req).id, String(req.params.id))),
  ),
);

export { requireObject };
export default router;
