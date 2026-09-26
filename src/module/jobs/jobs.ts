import { config } from "../../shared/config";
import { getCollection } from "../../shared/db";
import { Collections } from "../../shared/collections";
import { detectFraud, recomputeBadges } from "../../services/fraud.service";
import { recomputeCustomerInsights } from "../../services/rebooking.service";
import { computeBusinessScore, persistBusinessScore } from "../../services/score.service";
import { expireStaleInstantSlots } from "../../services/instant-slot.service";
import type { BusinessDoc } from "../../types/domain";

/**
 * All scheduled logic for the platform.
 *
 * There is no `node-cron` here on purpose: the same job set has to be runnable
 * from three places — the in-process loop below, a single POST from an external
 * scheduler (see `route.ts`), and a one-off CLI run during testing. Keeping each
 * job as a plain async function means all three share exactly one implementation.
 */

export type JobName =
  | "rebooking-insights"
  | "business-scores"
  | "fraud-detection"
  | "badges"
  | "expire-instant-slots";

export interface JobResult {
  name: JobName;
  ok: boolean;
  durationMs: number;
  detail: Record<string, unknown>;
  error?: string;
}

export interface JobRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: JobResult[];
}

/** Jobs that accept a single-business scope. */
const PER_BUSINESS_JOBS: readonly JobName[] = ["business-scores", "badges"];

const NIGHTLY_JOBS: JobName[] = [
  "rebooking-insights",
  "business-scores",
  "fraud-detection",
  "badges",
  "expire-instant-slots",
];

/** Every business that is active enough to be scored or badged. */
async function activeBusinessIds(): Promise<string[]> {
  const rows = await getCollection<BusinessDoc>(Collections.businesses)
    .find({ status: { $in: ["active", "pending_verification"] } })
    .toArray();
  return rows.map((row) => row._id);
}

export function isKnownJob(name: string): name is JobName {
  return (SCHEDULED_JOB_NAMES as readonly string[]).includes(name);
}

export function supportsBusinessScope(name: string): boolean {
  return (PER_BUSINESS_JOBS as readonly string[]).includes(name);
}

/** Runs one job scoped to a single business. */
async function runScopedJob(
  name: JobName,
  businessId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  if (name === "business-scores") {
    const result = await computeBusinessScore(businessId, now);
    await persistBusinessScore(result);
    return { businessId, score: result.score, period: result.period };
  }
  if (name === "badges") {
    const result = await recomputeBadges(businessId, now);
    return { businessId, awarded: result.awarded.length, revoked: result.revoked.length };
  }
  throw new Error(`Job "${name}" cannot be scoped to a single business`);
}

/**
 * One job, isolated so a single failure never aborts the rest of the run.
 * `businessId` restricts a per-business job instead of scanning every business.
 */
export async function runJob(
  name: JobName,
  now = new Date(),
  businessId?: string,
): Promise<JobResult> {
  const startedAt = Date.now();

  try {
    let detail: Record<string, unknown>;

    switch (name) {
      case "rebooking-insights": {
        const result = await recomputeCustomerInsights(businessId, now);
        detail = { ...result };
        break;
      }
      case "business-scores": {
        if (businessId) {
          detail = await runScopedJob(name, businessId, now);
          break;
        }
        const businessIds = await activeBusinessIds();
        for (const id of businessIds) {
          await persistBusinessScore(await computeBusinessScore(id, now));
        }
        detail = { businesses: businessIds.length, persisted: businessIds.length };
        break;
      }
      case "fraud-detection": {
        const flags = await detectFraud({ now });
        detail = { flagsRaised: flags.length };
        break;
      }
      case "badges": {
        if (businessId) {
          detail = await runScopedJob(name, businessId, now);
          break;
        }
        const businessIds = await activeBusinessIds();
        let awarded = 0;
        let revoked = 0;
        for (const id of businessIds) {
          const result = await recomputeBadges(id, now);
          awarded += result.awarded.length;
          revoked += result.revoked.length;
        }
        detail = { businesses: businessIds.length, awarded, revoked };
        break;
      }
      case "expire-instant-slots": {
        const expired = await expireStaleInstantSlots();
        detail = { expired };
        break;
      }
      default:
        throw new Error(`Unknown job: ${String(name)}`);
    }

    return { name, ok: true, durationMs: Date.now() - startedAt, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs the requested jobs sequentially, or the whole nightly set by default. */
export async function runJobs(
  names: JobName[] = NIGHTLY_JOBS,
  now = new Date(),
  businessId?: string,
): Promise<JobRunReport> {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const results: JobResult[] = [];
  for (const name of names) {
    results.push(await runJob(name, now, businessId));
  }
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    results,
  };
}

export const SCHEDULED_JOB_NAMES: readonly JobName[] = NIGHTLY_JOBS;

/**
 * A plain `setInterval` loop, deliberately not a cron parser: it fires the
 * nightly set once the clock reaches the configured hour, then at most once per
 * day. This avoids a dependency and keeps the "nightly" contract obvious.
 */
export function startScheduler(): { stop: () => void } {
  const intervalMs = 24 * 3_600_000;
  let lastRunKey: string | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < config.business.scorePeriodCronHour) return;
    if (lastRunKey === dayKey) return;
    lastRunKey = dayKey;

    const report = await runJobs();
    const failed = report.results.filter((result) => !result.ok);
    console.log(
      `[scheduler] nightly run ${report.startedAt} finished in ${report.durationMs}ms` +
        (failed.length > 0 ? ` — ${failed.length} job(s) failed` : ""),
    );
  };

  const timer = setInterval(() => void tick(), Math.min(intervalMs, 60_000));
  // Do not hold the process open purely for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
