# Layan Server

The Layan booking & marketplace API: **Express 5 + TypeScript + the native MongoDB driver**.

This is not generic CRUD. Each area has a purpose-built service layer that owns its
own rules — availability is recomputed server-side, booking transitions go through a
state machine, balances live on one wallet, and anything computed (badges, scores,
CRM insights, fraud flags) has exactly one writer.

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill in the values
npm run seed              # loads data.json into MongoDB (destructive)
npm run dev               # http://localhost:3000
```

`JWT_SECRET` and `CRON_SECRET` have no safe defaults. Set both before deploying; the
job runner refuses to execute when `CRON_SECRET` is unset.

### Scripts

| Script              | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm run dev`       | Watch-mode server                                          |
| `npm run start`     | Production start                                           |
| `npm run typecheck` | `tsc --noEmit` — the same check CI runs                    |
| `npm run seed`      | Wipe and reload `data.json`; `-- --keep` skips the wipe    |
| `npm run jobs`      | Run the scheduled jobs from the CLI                        |
| `npm run smoke`     | Call every mounted route against a running server          |

---

## Architecture

```
index.ts            long-running server: connect -> index -> listen -> scheduler
api/index.ts        serverless handler: connect once per cold start, no scheduler
src/app.ts          express wiring, CORS, /health, error handler
src/routes/         the single route table mounted at /api
src/module/<name>/  one folder per feature area:
  route.ts          HTTP only — auth chain, parse the request, delegate, serialize
  <name>.ts         that feature's rules and queries; never reads `req`
src/services/       cross-module rules (availability, payments, booking state machine, …)
src/serializers/    role-aware redaction applied to every response
src/auth/           JWT issue/verify, password hashing, access middleware
src/shared/         config, collections, db + indexes, errors, response, utils
src/scripts/        seed, CLI job runner, route smoke test
```

| Module              | Owns                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `public`            | Categories, businesses, services, staff, search, instant slots          |
| `auth`              | Register, login, refresh, password, profile, sessions                   |
| `customer`          | Bookings, payments, wallet, reviews, waitlist, favourites, rebooking     |
| `business`          | Calendar, bookings, time off, CRM, team, services, promotions, finance   |
| `staff`             | The caller's own schedule, customers, portfolio, performance             |
| `admin`             | Users, verification, fraud, moderation, disputes, badges, audit logs     |
| `conversations`     | One thread per booking, messages, unread counts                         |
| `jobs`              | The five scheduled jobs plus the `CRON_SECRET` runner                    |

The layering rule: a `route.ts` may declare middleware, read the request and shape
the response, and nothing else. Every rule — a query filter, an ownership check, a
validation — lives in the module's `<name>.ts`, and anything genuinely cross-cutting
lives in `src/services/`. Because module files never import `express`, their rules are
callable from a script or a test directly.

Middleware order is part of each route's contract: `requireBusinessAccess` resolves
the caller's relationship to the business once, and the module receives that resolved
access gate as a plain argument.

### Data model

`data.json` is the source of truth for all 46 collections and their field names.
`src/shared/collections.ts` mirrors those names exactly, and `src/types/domain.ts`
holds one interface per collection. The seed script refuses to run if `data.json`
mentions a collection the code does not know about.

Documents are shared, not duplicated: a booking points at `customerId`, and the
customer record carries the CRM fields, wallet balance and preferences. There is one
conversation per booking, not one per participant.

### Security model

- Roles are exactly `customer`, `business_owner`, `staff`, `admin`. There is no guest
  role and no guest checkout.
- `requireBusinessAccess` resolves the caller's relationship to a business from the
  database. A `businessId` in a request body is never trusted for authorization.
- Authorization is asserted **before** a mutation, not after.
- `requirePermission` checks the staff member's own permission flags
  (`viewFinancials`, `viewCustomerData`, `manageCalendar`, `manageStaff`,
  `manageInventory`, `processRefunds`).
- Serializers redact per role: customers never see internal staff notes or full
  contact details, staff never see another stylist's schedule, and a stylist without
  `viewCustomerData` gets a 403 rather than a quietly empty customer list.
- Computed fields are server-owned and stripped from every write path: verification
  state, badges, `businessScore`, `Customer.insights`, policy snapshots, status
  history, `isVerifiedBooking`, and the availability/slot fields on a booking.
- Slot claims are guarded by a partial unique index on `slotKey` (a
  `"{staffId}::{startAt ISO}"` string, set only while `slotActive: true`), so any number
  of released rows can coexist but two concurrent claims on the same slot cannot both
  win — the loser's insert is a duplicate-key error, which the booking service maps to
  409.
- The job runner compares its secret in constant time and fails closed.

### Availability

Availability is never sent by the client and never trusted on the way back in.
`computeAvailability()` derives slots from the service duration, the staff member's
working hours and time off, existing bookings, business and location hours, and the
configured lead time. Booking, rescheduling and instant-slot claims all re-verify
against it. `search` returns a genuinely bookable next slot, not the next confirmed
appointment.

### Scheduled jobs

Each job is a plain async function, so the same implementation runs from all three
triggers: the in-process loop (`SCHEDULER_ENABLED=true`), an external cron calling
`POST /api/jobs/run`, or `npm run jobs`.

| Job                    | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `rebooking-insights`   | Recomputes `Customer.insights`, notifies overdue customers     |
| `business-scores`      | Recomputes the 0–100 Business Score and recommendations        |
| `fraud-detection`      | Raises flags; only an admin ever investigates or resolves     |
| `badges`               | Awards/revokes computed badges                                |
| `expire-instant-slots` | Closes instant slots whose window has passed                   |

A single job failing does not abort the run — the response is a per-job report.
`SCHEDULER_ENABLED` must be `false` on serverless, where the container does not
survive between invocations.

---

## API surface

All routes are mounted at `/api`. Authenticated routes expect
`Authorization: Bearer <accessToken>`.

| Prefix           | Auth            | Purpose                                    |
| ---------------- | --------------- | ------------------------------------------ |
| `/public`        | none            | Categories, businesses, services, search   |
| `/auth`          | none / self     | Register, login, refresh, profile, sessions |
| `/customer`      | customer        | Bookings, payments, wallet, reviews, waitlist, instant slots, CRM |
| `/business`      | owner/staff     | Calendar, bookings, staff, services, finance, disputes, scores |
| `/staff`         | staff           | The caller's own schedule, availability, customers, performance |
| `/admin`         | admin           | Users, verification, fraud, moderation, disputes, badges, audit |
| `/conversations` | participant     | One thread per booking, messages, unread    |
| `/jobs`          | `CRON_SECRET`   | External job runner                        |

`/api/public/*` is mounted before every authenticated router so the marketplace stays
reachable without a token, and `/api/jobs` is mounted last because it authenticates
with a shared secret rather than a user JWT.

Responses are `{ success: true, data }` or `{ success: false, error: { message, code,
details } }`. Errors carry an HTTP status and a stable `code`.

---

## Testing

There is no unit-test framework; correctness is checked by types plus a route smoke
test that talks to a real server.

```bash
npm run typecheck                     # must be clean before anything else
npm run seed                          # against a disposable database
npm run start &                       # or npm run dev
npm run smoke                         # every route, every role
npm run smoke -- --read-only          # GET only, no writes
npm run smoke -- --strict             # also require 2xx from every GET
```

`src/scripts/smoke.ts` builds its route list from the exported `API_MODULES` mount
table, so it cannot drift from what the server serves, and it substitutes real fixture
ids from `data.json` for the path parameters. Each route is called anonymously and as
admin, owner, staff and customer. A route passes on a 2xx **or** on a 4xx that our own
error handler produced as `{ success: false, error: { code } }`; it fails on a 5xx, on
Express's default HTML (which means the path matched nothing), or on any body that is
not the response envelope.

Because non-GET routes really are executed, run it only against a scratch database.

Live route testing needs a reachable MongoDB. The static guarantees that hold without one:

- `npm run typecheck` is clean.
- Every module is exactly `route.ts` + `<name>.ts`, and no `route.ts` imports
  `getCollection`, `Collections`, or a service directly — the HTTP layer owns nothing
  but middleware, parsing, delegation and serialization.
- No logic file imports `express` or reads `req`; the resolved access gate is passed
  in as a plain argument.
- Every `requireBusinessAccess(":param")` reference is a parameter of the path it
  guards, so the authorization check can never be aimed at a hard-coded id.

---

## Data & seeding

`data.json` is never modified by the seed. Two things are adjusted in memory:

- The fixture's `passwordHash` values are placeholders, so every seeded user gets a
  real bcrypt hash of the demo password `12345678`.
- The required admin account is upserted last, so the documented credentials work
  regardless of the fixture's own admin row.

Seeded examples: Jamal Hussain is a stylist, Priya Shah is a salon manager, both at
Fade Factory.

`npm run seed` clears all 46 collections first. Use `-- --keep` to insert without
deleting, and confirm you are pointed at the intended database first.
