import "dotenv/config";
import { config } from "../shared/config";
import { connectDb, disconnectDb } from "../shared/db";
import { runJobs, SCHEDULED_JOB_NAMES, type JobName } from "../module/jobs/jobs";
import { computeBusinessScore, persistBusinessScore } from "../services/score.service";
import { recomputeBadges } from "../services/fraud.service";

/**
 * Runs the job set from the CLI. Useful for a manual trigger, for verifying a
 * deployment before wiring an external scheduler, and for local testing without
 * booting the HTTP server.
 *
 *   npm run jobs                          # the whole nightly set
 *   npm run jobs -- business-scores       # one job
 *   npm run jobs -- --business-id b_123   # scope a job to one business
 */

function parseArgs(argv: string[]): { names: JobName[]; businessId?: string } {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const businessFlag = argv.indexOf("--business-id");
  const businessId = businessFlag >= 0 ? argv[businessFlag + 1] : undefined;

  const names = positional
    .map((value) => value.trim())
    .filter((value) => SCHEDULED_JOB_NAMES.includes(value as JobName)) as JobName[];

  if (names.length === 0) return { names: [...SCHEDULED_JOB_NAMES], ...(businessId ? { businessId } : {}) };
  return { names, ...(businessId ? { businessId } : {}) };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const { names, businessId } = parseArgs(requested);

  // A per-business run is only meaningful for the per-business jobs; the rest
  // are global, so refuse an obviously contradictory invocation rather than
  // silently ignoring the flag.
  if (businessId) {
    const perBusiness: JobName[] = ["business-scores", "badges"];
    for (const name of names) {
      if (!perBusiness.includes(name)) {
        throw new Error(`--business-id is only supported for: ${perBusiness.join(", ")}`);
      }
    }
  }

  await connectDb(config.mongoUri, config.dbName);

  let report;
  if (businessId) {
    const results: Array<Record<string, unknown>> = [];
    for (const name of names) {
      const startedAt = Date.now();
      try {
        const detail =
          name === "business-scores"
            ? await (async () => {
                const score = await computeBusinessScore(businessId);
                await persistBusinessScore(score);
                return { businessId, score: score.score };
              })()
            : await recomputeBadges(businessId);
        results.push({ name, ok: true, durationMs: Date.now() - startedAt, detail });
      } catch (error) {
        results.push({
          name,
          ok: false,
          durationMs: Date.now() - startedAt,
          detail: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    report = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      results,
    };
  } else {
    report = await runJobs(names);
  }

  for (const result of report.results) {
    const status = result.ok ? "ok" : "FAILED";
    console.log(`[${status}] ${result.name} (${result.durationMs}ms)`, JSON.stringify(result.detail));
    if (result.error) console.error(`         ${result.error}`);
  }
  const failures = report.results.filter((result) => !result.ok);
  await disconnectDb();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("Job run failed:", error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
