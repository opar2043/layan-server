/**
 * Route smoke test.
 *
 * Enumerates the mounted route table (from `API_MODULES`, so it can never drift
 * from what the server actually serves), substitutes real fixture ids taken from
 * `data.json`, and calls every route as an anonymous caller and as each role.
 *
 * A route passes when the answer is well-formed: a 2xx, or a 4xx that our own
 * error handler produced as `{ success: false, error: { code, message } }`. A route
 * fails when it 5xxs, when Express answers with its default HTML (meaning the path
 * never matched anything), or when the body is not the documented envelope.
 *
 * Usage:
 *   npm run smoke                    full coverage, mutations included
 *   npm run smoke -- --read-only     GET only (no writes)
 *   npm run smoke -- --strict        also require a 2xx from every GET as its owner
 *   SMOKE_BASE_URL=http://host/api npm run smoke
 *
 * Non-GET routes are exercised for real, so point this at a disposable database.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { API_MODULES } from "../routes";

interface Route {
  method: string;
  path: string;
}

type Row = Record<string, unknown>;

const BASE = (process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}/api`).replace(
  /\/$/,
  "",
);
const PASSWORD = process.env.SMOKE_PASSWORD ?? "12345678";
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const READ_ONLY = process.argv.includes("--read-only");
const STRICT = process.argv.includes("--strict");

const readOnlyMethods = new Set(["GET", "HEAD"]);

interface Outcome {
  route: Route;
  as: string;
  status: number;
  ok: boolean;
  note: string;
}

function loadFixture(): Row {
  const path = resolve(__dirname, "..", "..", "data.json");
  return JSON.parse(readFileSync(path, "utf8")) as Row;
}

function rows(fixture: Row, key: string): Row[] {
  const value = fixture[key];
  return Array.isArray(value) ? (value as Row[]) : [];
}

function firstId(fixture: Row, key: string, predicate: (row: Row) => boolean = () => true): string {
  const row = rows(fixture, key).find(predicate);
  return typeof row?._id === "string" ? row._id : "";
}

/** Path params are replaced with fixture ids so handlers reach real documents. */
function buildParams(fixture: Row): Record<string, string> {
  const business = rows(fixture, "businesses")[0] ?? {};
  const businessId = typeof business._id === "string" ? business._id : "";
  const staff = rows(fixture, "staff").find((row) => row.businessId === businessId) ?? {};
  const service = rows(fixture, "services").find((row) => row.businessId === businessId) ?? {};
  const booking =
    rows(fixture, "bookings").find(
      (row) => row.businessId === businessId && row.staffId === staff._id,
    ) ??
    rows(fixture, "bookings")[0] ??
    {};
  const customer =
    rows(fixture, "customers").find((row) => row.businessId === businessId) ?? rows(fixture, "customers")[0] ?? {};
  const conversation = rows(fixture, "conversations")[0] ?? {};

  return {
    businessId: businessId || "smk-business",
    id: businessId || "smk-business",
    staffId: typeof staff._id === "string" ? staff._id : "smk-staff",
    serviceId: typeof service._id === "string" ? service._id : "smk-service",
    bookingId: typeof booking._id === "string" ? booking._id : "smk-booking",
    customerId: typeof customer._id === "string" ? customer._id : "smk-customer",
    conversationId: typeof conversation._id === "string" ? conversation._id : "smk-conversation",
    slugOrId: typeof business.slug === "string" ? business.slug : (businessId || "smk-business"),
    targetId: "smk-target",
    reviewId: firstId(fixture, "reviews"),
    promotionId: firstId(fixture, "promotions"),
    paymentId: firstId(fixture, "payments"),
    disputeId: firstId(fixture, "disputes"),
    instantSlotId: firstId(fixture, "instantSlots"),
    resourceId: firstId(fixture, "resources"),
    formId: firstId(fixture, "consultationFormTemplates"),
    submissionId: firstId(fixture, "consultationFormSubmissions"),
    campaignId: firstId(fixture, "campaigns"),
    flagId: firstId(fixture, "fraudFlags"),
    packageId: firstId(fixture, "customerPackages"),
    membershipId: firstId(fixture, "customerMemberships"),
    orderId: firstId(fixture, "orders"),
    productId: firstId(fixture, "products"),
    sessionId: "smk-session",
  };
}

function routeTable(): Route[] {
  const table: Route[] = [];
  for (const { prefix, router } of API_MODULES) {
    for (const layer of router.stack as unknown as Array<{
      route?: { path: string; methods: Record<string, boolean> };
    }>) {
      if (!layer.route) continue;
      // `route.methods` is the authoritative list: a layer's `stack` holds the
      // middleware too, and counting those would report every route twice.
      for (const method of Object.keys(layer.route.methods)) {
        table.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
      }
    }
  }
  const seen = new Set<string>();
  return table
    .filter((route) => {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function concrete(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => params[key] ?? `smk-${key}`);
}

interface CallResult {
  status: number;
  contentType: string;
  envelope: { success?: boolean; error?: { code?: string; message?: string } } | null;
  raw: string;
}

async function call(
  route: Route,
  params: Record<string, string>,
  token: string | null,
  as: string,
): Promise<CallResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (route.path.startsWith("/jobs")) headers["x-cron-secret"] = CRON_SECRET;

  const method = route.method === "HEAD" ? "GET" : route.method;
  const init: RequestInit = { method, headers };
  if (!readOnlyMethods.has(method)) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify({});
  }

  const response = await fetch(`${BASE}${concrete(route.path, params)}`, init);
  const raw = await response.text();
  let envelope: CallResult["envelope"] = null;
  try {
    envelope = JSON.parse(raw) as CallResult["envelope"];
  } catch {
    envelope = null;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    envelope,
    raw,
  };
}

function judge(route: Route, as: string, result: CallResult, mustSucceed: boolean): Outcome {
  const where = `${route.method} ${route.path} [${as}]`;

  if (result.status >= 500) {
    return { route, as, status: result.status, ok: false, note: `server error: ${result.raw.slice(0, 160)}` };
  }
  if (result.contentType.includes("text/html") || result.raw.trimStart().startsWith("<")) {
    return { route, as, status: result.status, ok: false, note: "unmatched route (express default response)" };
  }
  if (!result.envelope || typeof result.envelope.success !== "boolean") {
    return { route, as, status: result.status, ok: false, note: `not the response envelope: ${result.raw.slice(0, 160)}` };
  }
  if (mustSucceed && (result.status < 200 || result.status >= 300)) {
    const detail = result.envelope.error?.message ?? "no error message";
    return { route, as, status: result.status, ok: false, note: `expected 2xx, got ${detail}` };
  }
  return { route, as, status: result.status, ok: true, note: "" };
}

async function login(email: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await response.json()) as { data?: { token?: string } };
  if (!body.data?.token) {
    throw new Error(`login failed for ${email}: ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data.token;
}

async function main(): Promise<void> {
  const fixture = loadFixture();
  const params = buildParams(fixture);
  const table = routeTable().filter((route) => !READ_ONLY || readOnlyMethods.has(route.method));
  const users = rows(fixture, "users");

  const emailFor = (predicate: (row: Row) => boolean): string | null => {
    const row = users.find((user) => predicate(user) && typeof user.email === "string");
    return typeof row?.email === "string" ? row.email : null;
  };

  const actors: Array<{ as: string; token: string | null }> = [{ as: "anonymous", token: null }];
  const wanted: Array<{ as: string; email: string | null; role: string }> = [
    { as: "admin", email: process.env.SMOKE_ADMIN_EMAIL ?? "admin.layan@gmail.com", role: "admin" },
    { as: "owner", email: emailFor((row) => row.role === "business_owner"), role: "business_owner" },
    { as: "staff", email: emailFor((row) => row.role === "staff"), role: "staff" },
    { as: "customer", email: emailFor((row) => row.role === "customer"), role: "customer" },
  ];

  for (const wantedActor of wanted) {
    if (!wantedActor.email) {
      console.log(`skip  no seeded ${wantedActor.role} user found in data.json`);
      continue;
    }
    try {
      actors.push({ as: wantedActor.as, token: await login(wantedActor.email) });
    } catch (error) {
      console.log(`skip  ${wantedActor.as}: ${(error as Error).message}`);
    }
  }

  console.log(`base      ${BASE}`);
  console.log(`routes    ${table.length} (${READ_ONLY ? "read-only" : "full"})`);
  console.log(`actors    ${actors.map((actor) => actor.as).join(", ")}\n`);

  const outcomes: Outcome[] = [];
  // Reads first: a broken write should not hide a broken read.
  const ordered = [...table].sort((a, b) =>
    Number(readOnlyMethods.has(b.method)) - Number(readOnlyMethods.has(a.method)),
  );

  for (const actor of actors) {
    for (const route of ordered) {
      const mustSucceed = STRICT && readOnlyMethods.has(route.method) && actor.as === "owner";
      try {
        const result = await call(route, params, actor.token, actor.as);
        outcomes.push(judge(route, actor.as, result, mustSucceed));
      } catch (error) {
        outcomes.push({
          route,
          as: actor.as,
          status: 0,
          ok: false,
          note: `request failed: ${(error as Error).message}`,
        });
      }
    }
  }

  const failures = outcomes.filter((outcome) => !outcome.ok);
  for (const failure of failures) {
    console.log(`FAIL  ${failure.status} ${failure.route.method} ${failure.route.path} [${failure.as}] — ${failure.note}`);
  }

  const covered = new Set(outcomes.map((outcome) => `${outcome.route.method} ${outcome.route.path}`));
  console.log(`\nrequests ${outcomes.length}`);
  console.log(`routes   ${covered.size}/${table.length} exercised`);
  console.log(`failures ${failures.length}`);

  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
