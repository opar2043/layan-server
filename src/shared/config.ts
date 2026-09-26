/** Immutable server config, read once from the environment. */
function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

export const config = {
  port: int(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017",
  dbName: process.env.DB_NAME ?? "layan",
  jwtSecret: process.env.JWT_SECRET ?? "layan-dev-secret",
  jwtExpiresInSeconds: int(process.env.JWT_EXPIRES_IN_SECONDS, 60 * 60 * 24 * 7),

  /** Master switch for the in-process nightly scheduler (off on serverless). */
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),
  /** Shared secret guarding the externally-triggerable job runner. */
  cronSecret: process.env.CRON_SECRET ?? "",

  business: {
    /** Business-score recompute cadence, used for the job's idempotency period key. */
    scorePeriodCronHour: int(process.env.SCORE_CRON_HOUR, 3),
  },

  availability: {
    /** Slots closer than this to now are never offered (minutes). */
    defaultLeadTimeMinutes: int(process.env.DEFAULT_LEAD_TIME_MINUTES, 60),
    /** Never generate availability further out than this (days). */
    defaultMaxAdvanceDays: int(process.env.DEFAULT_MAX_ADVANCE_DAYS, 60),
    /** Default horizon for a single availability request (days). */
    defaultHorizonDays: int(process.env.DEFAULT_HORIZON_DAYS, 14),
    /** A residual gap smaller than this counts as fragmentation for gap scoring. */
    fragmentationThresholdMinutes: int(process.env.FRAGMENTATION_THRESHOLD_MINUTES, 15),
    /** Instant slots are published when a booking cancels this close to startAt. */
    instantSlotWindowHours: int(process.env.INSTANT_SLOT_WINDOW_HOURS, 3),
  },

  fraud: {
    chargebackWindowDays: int(process.env.CHARGEBACK_WINDOW_DAYS, 90),
    chargebackThreshold: int(process.env.CHARGEBACK_THRESHOLD, 3),
    sameDayCancelWindowDays: int(process.env.SAME_DAY_CANCEL_WINDOW_DAYS, 7),
    sameDayCancelThreshold: int(process.env.SAME_DAY_CANCEL_THRESHOLD, 3),
  },

  rebooking: {
    /** A customer is "overdue" once daysSinceLastVisit exceeds interval + this grace. */
    graceDays: int(process.env.REBOOK_GRACE_DAYS, 3),
  },
} as const;

export type Config = typeof config;
