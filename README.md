# Layan — Backend Server

Service-booking marketplace backend for **Layan**, covering four roles: **Customer**, **Salon/Business Owner**, **Staff Member** and **Platform Admin**.

Node.js + Express + TypeScript + MongoDB, **52 API endpoints across 12 modules** (plus `GET /health`).

---

## ⚠️ Deviations from the master prompt (read this first)

Three deliberate departures. Everything else follows the spec exactly.

| # | Prompt said | This project does | Why |
|---|---|---|---|
| 1 | MongoDB **with Mongoose** as the ODM | MongoDB via the **official native `mongodb` driver**, no ODM | Your instruction: *"dont use mongoose"* |
| 2 | `location { lat, lng }` | `location { latitude, longitude }` | Your `data.json` uses `latitude`/`longitude`; you chose data.json |
| 3 | Handle Mongoose `ValidationError` | Hand-written validation in `src/shared/validate.ts` | Mongoose's error type does not exist without Mongoose. The global handler **still** maps driver duplicate-key `code 11000` → `409` |

### What dropping the ODM means for you

The four things Mongoose used to do are now explicit, so nothing is lost — it is just visible:

| Mongoose gave you | Native-driver replacement |
|---|---|
| Schema validation | `src/shared/validate.ts` — `requireString`, `requireNumber`, `requireEnum`, `requireDate`, `requireId`… all throw `ApiError.badRequest` → **400** |
| Automatic `createdAt` / `updatedAt` | Stamped explicitly in every controller |
| `.populate("businessId")` | `src/shared/populate.ts` — one `$in` query per ref field, result inlined as `business`, `customer`, `service`, `staff` |
| Automatic index creation | `createIndexes()` in `src/shared/db.ts`, run once at boot |

`model.ts` files still follow the same convention: each exports the **TS interface** (`export interface IBooking extends Document`) **and the model accessor** (`export const BookingModel = () => getCollection<IBooking>(...)`).

### Two small behaviour decisions worth knowing

Both are flagged here rather than made silently:

1. **`PATCH /api/bookings/:id/status` is business-side per the spec, but a customer may cancel.** The route is guarded by `identifyAny` (per spec), which also accepts a Firebase customer — so *some* role policy was required. Owners/staff may set any status; a customer may only set `cancelled` / `late_cancel` / `no_show`, and only on their own booking. Without this narrowing a customer could mark their own visit `attended` and unlock a review for an appointment that never happened.
2. **`PATCH /api/bookings/:id/checkout` defaults `amountPaid` to `totalPrice`.** The spec marks `amountPaid` optional. Since checkout implies the customer settled up, omitting it means "paid in full" rather than "no idea".
3. **`GET /api/businesses/:id` inlines the bookable staff roster.** `GET /api/staff` is owner-only, so without this a signed-out visitor has no way to see who they can book with — the booking and waitlist flows both offer a staff choice. Only active staff are returned, and the projection is exclusion-only (`passwordHash`, `timeOff` and `commissionRate` removed); MongoDB rejects a projection that mixes inclusion with exclusion.
4. **A staff member sending an owner-only field to `PATCH /api/staff/:id` gets a `403`, not a silent no-op.** Returning `200` for an edit that was dropped would leave the caller believing their change landed.

---

## Setup

```bash
cd layan-salon
npm install
cp .env.example .env      # then fill in your values
npm run dev               # ts-node-dev, hot reload on http://localhost:3000
```

Verify it booted:

```bash
curl http://localhost:3000/health
# {"success":true,"message":"Layan server is healthy","data":null}
```

### Scripts

| Script | Command |
|---|---|
| `npm run dev` | `ts-node-dev --respawn --transpile-only src/index.ts` |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | `node dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` |

### Environment

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=<appName>
DB_NAME=layan_db
PORT=3000
JWT_SECRET=<long random string>
JWT_EXPIRES_IN=7d
```

`.env` is gitignored; `.env.example` holds placeholder values only.

### No seed data

Nothing is inserted at boot. `data/data.json` is a *reference* file showing the exact shape of 2 example documents per collection, so you can read the response format without running anything.

### Demo accounts

An **opt-in** seed script creates one account per role plus representative data. It is never run automatically:

```bash
npm run seed:demo
```

**Password for every account: `12345678`**

| Role | Email | Notes |
|---|---|---|
| Platform admin | `admin.layan@gmail.com` | Full platform access; 1 business waiting for approval |
| Business owner | `owner.layan@gmail.com` | Owns **Layan Demo Salon** — approved, 4 services, 1 staff member |
| Staff | `staff.layan@gmail.com` | **Sam Stylist**, `manager`, Mon–Wed 09:00–17:00 |
| Customer | `customer.layan@gmail.com` | Chris Customer, one favourite business |
| Pending owner | `pending.layan@gmail.com` | Owns **Newcomer Nails**, `pending` — invisible in public search until approved |

Re-running is safe: every account is upserted by email.

The customer account is the odd one out — customers never hold a backend password. The script creates a real Firebase Auth user over the Identity Toolkit REST API (using `NEXT_PUBLIC_FIREBASE_API_KEY` from `../layan-frontend/.env.local`) and links it to a Mongo record through `users/sync`. If that key is missing or the request fails, the script prints a note and you can instead sign up at `/register` on the Customer tab with the same email and password.

> ⚠️ **There is no admin-creation endpoint** in the spec, so the `admins` collection must be bootstrapped directly before any `requireRole(ADMIN)` route will be usable. The seed script above does this.

---

## Authentication model

**Customers never get a password or a JWT from this server.** They authenticate with Firebase in the frontend, which then sends:

```
x-firebase-uid: <the uid Firebase verified>
```

`requireFirebaseUser` (`src/shared/firebase.middleware.ts`) reads that header.

> 🔒 **Production TODO, already flagged in the code:** the header is currently trusted as-is, so anyone who can reach the server can forge it. Before launch, replace it with real `firebase-admin` verification:
> ```ts
> const decoded = await getAuth().verifyIdToken(req.headers.authorization!);
> req.firebaseUid = decoded.uid;
> ```

**Owner, Staff and Admin** authenticate with `Authorization: Bearer <token>` from `POST /api/auth/login`. The JWT payload is `{ id, role, businessId?, email }` — `businessId` present for owner/staff, absent for admin. Passwords are bcrypt-hashed (10 rounds) and never returned by any endpoint.

### Response envelope

Every success: `{ "success": true, "message": "...", "data": ... }`
Every error: `{ "success": false, "message": "...", "errors"?: ... }` — no stack traces ever reach the client.

### Legend for the endpoint tables

| Label | Means |
|---|---|
| `Public` | No credentials |
| `Firebase` | `x-firebase-uid` header — customers only |
| `JWT` | `Authorization: Bearer` — owner / staff / admin |
| `JWT Owner` / `JWT Staff` / `JWT Admin` | JWT with that specific role |

---

## Role workflows

### 👤 Customer (Firebase)

1. **Sign in** with Firebase in the app, then **create or fetch the profile** — `POST /api/users/sync`. Idempotent: first call creates, later calls return the existing profile untouched. The response contains a unique `referralCode`.
2. **Tidy the profile** — `PATCH /api/users/me` for name, phone, gender preference and location; `PATCH /api/users/me/favourites` with `{ businessId, action }` to follow a salon.
3. **Discover** — `GET /api/businesses?category=&city=&instantBook=&q=` (verified businesses only) and `GET /api/businesses/:id`, which inlines that business's active services.
4. **Book** — `POST /api/bookings` with `serviceId`, `startTime` and optional `staffId`. The server derives `endTime` from the service duration, snapshots `totalPrice`, and **rejects with 409** if that staff member already has an overlapping booking. Follow progress with `GET /api/bookings`.
5. **Lose out** — `POST /api/waitlist` queues the customer for a service, and `DELETE /api/waitlist/:id` withdraws. The business works the queue via `GET /api/waitlist` and advances entries with `PATCH /api/waitlist/:id`.
6. **Message the salon** — `POST /api/messages` with `{ businessId, text }`; read back with `GET /api/messages?businessId=`. `senderRole` is forced to `customer` server-side, so a customer can never post as the business.
7. **After the visit** — the business marks the booking `attended` via checkout or status, which sets `isVerifiedReviewEligible`. Only then will `POST /api/reviews` accept a review (one per booking, unique index enforced).
8. **Wallet** — `GET /api/wallet/me` creates the wallet on first read; `POST /api/wallet/me/topup`, `POST /api/wallet/me/redeem` and `GET /api/wallet/me/transactions` (append-only ledger) manage balances.

### 🏪 Owner (JWT)

1. **Sign up** — `POST /api/auth/register/owner` creates the owner *and* their business in one step and returns a token. The business starts **unverified**, so it is invisible in public search until an admin approves it.
2. **Set up the shop** — `GET /api/businesses/me` and `PATCH /api/businesses/me` (whitelisted: profile, images, portfolio, amenities, opening hours, location merge, instant-book flag). Verification flags and `businessScore` are admin-only and silently ignored here.
3. **Catalogue** — `POST /api/services`, then `PATCH`/`DELETE` (soft delete sets `isActive = false`, so past bookings keep their history).
4. **Hire** — `POST /api/staff` with a temporary password (hashed on the way in, never returned). `PATCH /api/staff/:id` controls permissions, assigned services, commission and the active flag; `DELETE` soft-deletes.
5. **Work the queue** — `GET /api/waitlist` and `PATCH /api/waitlist/:id` to move entries `waiting → notified → booked`.
6. **Run the day** — `GET /api/bookings` (auto-scoped to the business), `PATCH /api/bookings/:id/status` to confirm/complete, and `PATCH /api/bookings/:id/checkout` to record payment, tip and method — which auto-transitions the booking to `attended` and makes it review-eligible.
7. **Inbox** — `GET /api/messages/threads` for the aggregated inbox, `GET /api/messages?customerId=` for one thread, `POST /api/messages` to reply.
8. **Grow** — `POST /api/promotions` (auto-scoped to the business) and `PATCH`/`DELETE` for its own promotions only. `PATCH /api/reviews/:id/reply` answers a review of their own business.
9. **Escalate** — `POST /api/admin/disputes` on any of their bookings.

### 💇 Staff (JWT)

1. **Sign in** with `POST /api/auth/login` and `role: "staff"` — the token carries the employer's `businessId`.
2. **See the day** — `GET /api/bookings` is auto-scoped to bookings **assigned to them**; they cannot see the whole business diary or another staff member's clients.
3. **Manage availability** — `PATCH /api/staff/:id` against their own id, limited to `workingHours` and `timeOff`. Attempts to change `commissionRate`, `permissionLevel` or `isActive` are ignored.
4. **Complete appointments** — `PATCH /api/bookings/:id/status` and `PATCH /api/bookings/:id/checkout`, restricted to their own assigned bookings.
5. **Inbox** — `GET /api/messages/threads` and `GET /api/messages?customerId=`, replying as the business.

### 🛡️ Platform Admin (JWT)

1. **Bootstrap** an admin document directly in Mongo (no endpoint exists — see note above), then `POST /api/auth/login` with `role: "admin"`.
2. **Review businesses** — `GET /api/businesses/pending`, then `PATCH /api/businesses/:id/verify` with `{ status }`. The three flags `verificationStatus`, `isBusinessVerified` and `isIdentityVerified` are always written together, so they can never disagree.
3. **Watch the platform** — `GET /api/admin/analytics` (business/customer counts, booking status breakdown, cancellation & no-show rate, GMV and tips summed over attended bookings only) and `GET /api/admin/fraud-flags` (customers with **≥ 3** cancelled/late-cancel/no-show incidents, with a per-status tally).
4. **Settle disputes** — `GET /api/admin/disputes?status=` and `PATCH /api/admin/disputes/:id`. Resolving or rejecting **requires** a `resolutionNote`.
5. **Run platform-wide promos** — `POST /api/promotions` with no business scope; admins may edit **only** platform-wide promotions, owners **only** their own.
6. **Audit customers** — `GET /api/users` (paginated).

---

## Endpoint reference — 52 endpoints

### `auth` — 3 endpoints
Owner / Staff / Admin only. **No customer authentication lives here.**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register/owner` | Public | Create owner + business, returns `{ token, role, business }` (password omitted) |
| POST | `/api/auth/login` | Public | `{ email, password, role }` → `{ token, role, businessId }`. `role: "customer"` is rejected |
| GET | `/api/auth/me` | JWT | Resolves the Business / Staff / Admin profile behind the token |

### `users` — 5 endpoints
Customer profiles. **No password field** — identity is `firebaseUid`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/users/sync` | Firebase | Idempotent first-login upsert; generates `referralCode` |
| GET | `/api/users/me` | Firebase | Own profile |
| PATCH | `/api/users/me` | Firebase | Basics, location, favourite categories |
| PATCH | `/api/users/me/favourites` | Firebase | `{ businessId, action: "add"\|"remove" }` via `$addToSet`/`$pull` |
| GET | `/api/users` | JWT Admin | Paginated customer list (`?city`, `?q`) |

### `businesses` — 6 endpoints
Route order matters: `/me` and `/pending` are registered **before** the `/:id` catch-all.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/businesses` | Public | Discovery. `?category`, `?city`, `?instantBook`, `?q`, `?sort=score`. Verified-only by default |
| GET | `/api/businesses/me` | JWT Owner | Own business |
| PATCH | `/api/businesses/me` | JWT Owner | Whitelisted fields; merges `location` |
| GET | `/api/businesses/pending` | JWT Admin | `verificationStatus: pending` review queue |
| PATCH | `/api/businesses/:id/verify` | JWT Admin | `{ status }` — flips all three verification flags together |
| GET | `/api/businesses/:id` | Public | Single profile **with active services and the bookable staff roster inlined** |

### `services` — 5 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/services` | JWT Owner | Create on own business |
| GET | `/api/services` | Public | `?businessId=`; owner/staff may omit it (falls back to their business) |
| GET | `/api/services/:id` | Public | Single service; 404 if deactivated |
| PATCH | `/api/services/:id` | JWT Owner | Must own the service |
| DELETE | `/api/services/:id` | JWT Owner | **Soft** delete (`isActive = false`) |

### `staff` — 5 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/staff` | JWT Owner | Invite with temp password (hashed, never returned) |
| GET | `/api/staff` | JWT Owner | Scoped to own business, `servicesOffered` populated |
| GET | `/api/staff/:id` | JWT Owner/Staff | Owner, or the staff member themselves |
| PATCH | `/api/staff/:id` | JWT Owner/Staff | Owner: full staff whitelist. Staff: **own** `workingHours`/`timeOff` only; any owner-only field in the body is a `403` |
| DELETE | `/api/staff/:id` | JWT Owner | **Soft** delete (`isActive = false`) |

### `bookings` — 5 endpoints
The shared source of truth: reviews, wallet ledger and disputes all key off a booking.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/bookings` | Firebase | Derives `endTime` from service duration; **409 on staff overlap** |
| GET | `/api/bookings` | Either | Auto-scoped: customer→own, owner→business, staff→own assignments, admin→all. `?status` |
| GET | `/api/bookings/:id` | Either | Access-checked; service/business/customer/staff populated |
| PATCH | `/api/bookings/:id/status` | Either | `{ status }`. `attended` ⇒ `isVerifiedReviewEligible = true`. Customers may only cancel |
| PATCH | `/api/bookings/:id/checkout` | JWT Owner/Staff | `{ amountPaid?, tip?, paymentMethod? }`. Auto-transitions to `attended` |

### `waitlist` — 4 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/waitlist` | Firebase | Join queue; business derived from the service |
| DELETE | `/api/waitlist/:id` | Firebase | Withdraw own entry |
| GET | `/api/waitlist` | JWT Owner | Own business, `?status`, customer + service populated |
| PATCH | `/api/waitlist/:id` | JWT Owner | `{ status }` |

### `reviews` — 3 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/reviews` | Firebase | Requires own booking + `isVerifiedReviewEligible` + no existing review. Sub-scores inherit `overall` |
| GET | `/api/reviews` | Public | `?businessId=` required; customer name populated |
| PATCH | `/api/reviews/:id/reply` | JWT Owner | Must own the reviewed business |

### `wallet` — 4 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/wallet/me` | Firebase | Creates the wallet lazily on first read |
| POST | `/api/wallet/me/topup` | Firebase | `{ type: loyalty_earn\|referral_credit\|gift_card_topup, amount, note? }` |
| POST | `/api/wallet/me/redeem` | Firebase | `{ type: loyalty_redeem\|gift_card_redeem, amount }` — 400 if insufficient |
| GET | `/api/wallet/me/transactions` | Firebase | Append-only ledger, newest first |

### `messages` — 3 endpoints
`threadId` is always `"<customerId>_<businessId>"`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/messages` | Either | Party, ids and `senderRole` all derived from the credential, never the body |
| GET | `/api/messages/threads` | JWT Owner/Staff | `$sort` desc + `$group` → latest message per thread |
| GET | `/api/messages` | Either | Customer `?businessId=`; business `?customerId=` (defaults to own business). Oldest first |

### `promotions` — 4 endpoints
`businessId: null` = platform-wide.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/promotions` | JWT Owner/Admin | Owner → own business; admin → platform-wide |
| GET | `/api/promotions` | Public | Only windows containing *now*. `?businessId=` adds that business's + platform-wide |
| PATCH | `/api/promotions/:id` | JWT Owner/Admin | Owner: own only. Admin: platform-wide only |
| DELETE | `/api/promotions/:id` | JWT Owner/Admin | **Soft** deactivate |

### `admin` — 5 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/analytics` | JWT Admin | Counts, status breakdown, cancellation rate, GMV + tips over `attended` |
| GET | `/api/admin/fraud-flags` | JWT Admin | Customers with **≥ 3** failed-booking incidents |
| POST | `/api/admin/disputes` | Either | Customer or business; ids copied from the booking |
| GET | `/api/admin/disputes` | JWT Admin | `?status`, parties populated |
| PATCH | `/api/admin/disputes/:id` | JWT Admin | `{ status, resolutionNote? }` — note required to resolve/reject |

### `health` — 1 endpoint

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | Public | `{ success: true, message, data: null }` |

**Total: 52 module endpoints + 1 health = 53.**

---

## Project structure

```
layan-salon/
├── src/
│   ├── index.ts                     entrypoint: env → connectDB → createIndexes → listen
│   ├── app.ts                        createApp(): cors, json, morgan, /health, routers, 404, errorHandler
│   ├── shared/
│   │   ├── db.ts                    MongoClient, collection names, createIndexes()
│   │   ├── jwt.ts                   sign / verify / extract bearer
│   │   ├── password.ts              bcrypt hash + compare (10 rounds)
│   │   ├── apiError.ts              ApiError + static helpers
│   │   ├── apiResponse.ts           sendSuccess(res, code, message, data)
│   │   ├── asyncHandler.ts          wraps async handlers → next(err)
│   │   ├── errorHandler.ts          single global handler + notFoundHandler
│   │   ├── auth.middleware.ts       requireAuth, optionalAuth, requireRole
│   │   ├── firebase.middleware.ts   requireFirebaseUser (x-firebase-uid)
│   │   ├── identify.middleware.ts   identifyAny + resolveActor
│   │   ├── validate.ts              hand-written validation (replaces Mongoose)
│   │   ├── helpers.ts               serialize, pagination, timestamps
│   │   ├── populate.ts              ref resolution (replaces Mongoose .populate)
│   │   └── express.d.ts             req.auth / req.firebaseUid augmentation
│   ├── types/
│   │   ├── enums.ts                 all 10 required enums (+ 3 helpers)
│   │   └── index.ts                 JwtPayload, ApiSuccessBody, ApiErrorBody, PaginatedData
│   └── modules/<12 modules>/
│       ├── model.ts                 TS interface + model accessor
│       ├── route.ts                 middleware wiring only
│       └── <module>.ts              controllers — plain exported async functions
├── data/data.json                   2 example docs per collection (reference only, not seeded)
├── scripts/seed-demo.mjs            opt-in demo accounts + representative data
├── .env / .env.example
├── package.json
└── tsconfig.json
```

`route.ts` files contain **no business logic**; `<module>.ts` files contain **no route wiring**. Every controller is async and wrapped in `asyncHandler`, so none of them contain a `try/catch`.

---

## Verification status

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ **0 errors** |
| `npm run build` | ✅ compiles to `dist/` |
| `GET /health` | ✅ `200 {"success":true,...}` |
| MongoDB connectivity | ✅ **verified** — connected to `layan_db`, all indexes created |
| End-to-end workflow test | ✅ **113/113 checks passed** against the live database |
| `data/data.json` | ✅ 2 records per collection × 13 collections |
| Route count | ✅ **52** module endpoints, matching the spec's per-module counts |

The end-to-end run covered all four role workflows plus negative paths — duplicate email → 409, privilege escalation on `PATCH /businesses/me` → ignored, staff self-edit cannot raise `commissionRate`, cross-tenant booking/service access → 403, overlapping booking → 409, review before `attended` → 400, duplicate review → 409, wallet overdraft → 400, invalid enum/filter → 400, malformed ObjectId → 400, missing/garbage credentials → 401, wrong role → 403, unknown route → 404. **All test data was deleted afterwards; nothing is seeded at boot.**

Afterwards, a follow-up live pass verified the frontend's admin and staff pages against real data — the public staff roster, staff self-service (`workingHours` / `timeOff`, with owner-only fields rejected as `403`), the dispute lifecycle (`resolutionNote` required to close), the fraud threshold tally, and admin analytics — then re-cleaned the database. `scripts/seed-demo.mjs` was run afterwards to leave the documented demo accounts in place.

Four bugs were found and fixed by that run: negative longitudes being rejected on `PATCH /businesses/me`; public routes not populating `req.auth` (so the owner fallback on `GET /api/services` never fired); the analytics status breakdown reading only the first `$group` row; and `POST /api/staff` returning unpopulated `servicesOffered`.
