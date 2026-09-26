import { Router, type Request } from "express";
import { asyncHandler } from "../../middleware/error";
import { sendSuccess } from "../../shared/response";
import { queryInt } from "../../shared/utils";
import {
  getBusinessProfile,
  listBusinesses,
  listCategories,
  listServices,
  pagingFrom,
  parseNaturalLanguageQuery,
  runSearch,
  type PublicSearchParams,
} from "./public";

/**
 * Unauthenticated marketplace surface. Every query lives in `public.ts`; this
 * file only reads the request and shapes the response.
 */
const router = Router();

/** `GET /api/public/categories` — the service taxonomy. */
router.get(
  "/categories",
  asyncHandler(async (_req: Request, res) => sendSuccess(res, await listCategories())),
);

/** `GET /api/public/businesses` — the marketplace listing. */
router.get(
  "/businesses",
  asyncHandler(async (req: Request, res) => {
    const query = req.query as Record<string, unknown>;
    const paging = pagingFrom(query);
    return sendSuccess(
      res,
      await listBusinesses({
        ...paging,
        ...(typeof query.city === "string" ? { city: query.city } : {}),
        ...(typeof query.q === "string" ? { q: query.q } : {}),
      }),
    );
  }),
);

/** `GET /api/public/businesses/:slugOrId` — the public landing page payload. */
router.get(
  "/businesses/:slugOrId",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await getBusinessProfile(String(req.params.slugOrId))),
  ),
);

/** `GET /api/public/search` — Smart Search without authentication. */
router.get(
  "/search",
  asyncHandler(async (req: Request, res) => {
    const query = req.query as Record<string, unknown>;
    const params: PublicSearchParams = {
      limit: queryInt(query, "limit", 20, 1, 50),
      page: queryInt(query, "page", 1, 1, 10_000),
      ...(typeof query.q === "string" ? { q: query.q } : {}),
      ...(typeof query.categoryId === "string" ? { categoryId: query.categoryId } : {}),
      ...(typeof query.serviceId === "string" ? { serviceId: query.serviceId } : {}),
      ...(typeof query.city === "string" ? { city: query.city } : {}),
      ...(typeof query.postcode === "string" ? { postcode: query.postcode } : {}),
      ...(query.lat !== undefined ? { lat: Number(query.lat) } : {}),
      ...(query.lng !== undefined ? { lng: Number(query.lng) } : {}),
    };
    return sendSuccess(res, await runSearch(params));
  }),
);

/**
 * `GET /api/public/search/parse` — shows how a natural-language query was
 * understood. Backs the UI's "did you mean" affordance and query debugging.
 */
router.get(
  "/search/parse",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, parseNaturalLanguageQuery(typeof req.query.q === "string" ? req.query.q : "")),
  ),
);

/** `GET /api/public/services` — every active service, for the discovery feed. */
router.get(
  "/services",
  asyncHandler(async (req: Request, res) =>
    sendSuccess(res, await listServices(req.query as Record<string, unknown>)),
  ),
);

export default router;
