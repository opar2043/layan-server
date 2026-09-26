import { Router, type Request } from "express";
import { timingSafeEqual } from "crypto";
import { ApiError } from "../../shared/errors";
import { asyncHandler } from "../../middleware/error";
import { sendSuccess } from "../../shared/response";
import { isDbConnected } from "../../shared/db";
import { requireArray } from "../../shared/utils";
import {
  isKnownJob,
  runJobs,
  SCHEDULED_JOB_NAMES,
  supportsBusinessScope,
  type JobName,
} from "./jobs";

/**
 * `/api/jobs` — the externally-triggerable runner.
 *
 * The nightly logic runs in-process when `SCHEDULER_ENABLED` is on, but on
 * serverless platforms nothing keeps a container alive. This router lets an
 * external scheduler (GitHub Actions, a platform cron, Cloud Scheduler) POST the
 * same job list instead. It is authenticated with a shared secret, not a user
 * JWT, because the caller is infrastructure rather than a person.
 */
const router = Router();

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Accepts `x-cron-secret`, `?secret=`, or `Authorization: Bearer`. Compared in
 * constant time and only when `CRON_SECRET` is actually configured, so a
 * misconfigured deployment fails closed rather than running jobs for anyone.
 */
function assertCronAuthorized(req: Request): void {
  const expected = process.env.CRON_SECRET ?? "";
  if (expected.length === 0) {
    throw ApiError.internal("Job runner is not configured: set CRON_SECRET");
  }

  const header = req.header("x-cron-secret") ?? "";
  const querySecret = typeof req.query.secret === "string" ? req.query.secret : "";
  const authorization = req.header("authorization") ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  const provided = header || querySecret || bearer;
  if (!secretsMatch(provided, expected)) {
    throw ApiError.unauthorized("Invalid or missing job runner secret");
  }
}

/** `GET /api/jobs` — what this runner can execute. */
router.get("/", (_req, res) => {
  return sendSuccess(res, { jobs: SCHEDULED_JOB_NAMES });
});

/**
 * `POST /api/jobs/run` — runs one job, or the whole nightly set when the body
 * omits `jobs`. Always responds 200 with a per-job report: a partial failure is
 * a result to inspect, not a reason to lose the other jobs' output.
 */
router.post(
  "/run",
  asyncHandler(async (req: Request, res) => {
    assertCronAuthorized(req);
    if (!isDbConnected()) throw ApiError.internal("Database is not connected");

    const requested = Array.isArray(req.body)
      ? (requireArray(req.body, "body") as unknown[])
      : ((req.body?.jobs as unknown[] | undefined) ?? []);

    const names = (requested.length === 0 ? [...SCHEDULED_JOB_NAMES] : requested.map(String)).map(
      (name) => {
        if (!isKnownJob(name)) {
          throw ApiError.badRequest(`Unknown job "${name}"`, { allowed: SCHEDULED_JOB_NAMES });
        }
        return name;
      },
    ) as JobName[];

    const businessId = typeof req.body?.businessId === "string" ? req.body.businessId : undefined;
    if (businessId) {
      for (const name of names) {
        if (!supportsBusinessScope(name)) {
          throw ApiError.badRequest(`"${name}" cannot be scoped to a single business`, {
            allowed: ["business-scores", "badges"],
          });
        }
      }
    }

    return sendSuccess(res, await runJobs(names, new Date(), businessId));
  }),
);

export default router;
