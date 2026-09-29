# Layan — Backend Server

REST API for **Layan**, a service-booking marketplace with four roles: **Customer**, **Business Owner**, **Staff Member** and **Platform Admin**.

Node.js · Express · TypeScript · MongoDB (native driver — no ODM) · **52 endpoints across 12 modules** plus `GET /health`.

```
Frontend (Next.js :3000)  ──HTTP──▶  This server (:5000)  ──▶  MongoDB
```

---

## 1. Start here

### 1.1 Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | **18 or newer** | `node -v` |
| npm | 9+ | `npm -v` |
| MongoDB | Atlas cluster **or** local | you need a connection string |

### 1.2 Install

```bash
cd layan-salon
npm install
```

### 1.3 Configure

```bash
cp .env.example .env
```

Then edit `.env`:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=<appName>
DB_NAME=layan_db
PORT=5000
JWT_SECRET=any_long_random_string
JWT_EXPIRES_IN=7d
```

> `.env` is git-ignored. **Never commit it.** `.env.example` only holds placeholders.

### 1.4 Run

```bash
npm run dev          # hot reload on http://localhost:5000
```

`npm run dev` runs `predev` first, which frees port 5000 if something is already on it — you will see `[free-port] port 5000 busy (pids: …) — stopping` followed by `[free-port] port 5000 released` in that case.

Production:

```bash
npm run build        # tsc -> dist/
npm start            # node dist/index.js
```

### 1.5 Verify it is alive

```bash
curl http://localhost:5000/health
```

```json
{ "success": true, "message": "Layan server is healthy", "data": null }
```

On boot the server also prints the routes it mounted and creates any missing MongoDB indexes. If `MONGODB_URI` is missing it exits immediately with a clear message rather than starting half-configured.

### 1.6 Load the demo data (optional but recommended)

```bash
npm run seed:demo    # requires the server to already be running
```

Creates five demo accounts — admin, owner, staff and customer, plus one business left **pending** so the admin verification queue is not empty. The salon ships with services, staff, bookings and reviews. It is idempotent — safe to re-run. It reads `NEXT_PUBLIC_FIREBASE_API_KEY` from `layan-frontend/.env.local` so it can also create the customer's Firebase Auth user; without that file the customer account is skipped and everything else still seeds.

| Role | Email | Password | Notes |
|---|---|---|---|
| Admin | `admin.layan@gmail.com` | `12345678` | full platform access |
| Owner | `owner.layan@gmail.com` | `12345678` | owns **Layan Demo Salon** |
| Staff | `staff.layan@gmail.com` | `12345678` | works at Layan Demo Salon |
| Customer | `customer.layan@gmail.com` | `12345678` | **Firebase** sign-in, not JWT |
| Owner (pending) | `pending.layan@gmail.com` | `12345678` | business awaiting approval |

### 1.7 Where the code lives

```
src/
├── index.ts              entry point — opens the DB, then listens
├── app.ts                Express app: cors, json, morgan, /health, 12 routers, 404, error handler
├── modules/              one folder per feature area (see §7)
│   └── <name>/           route.ts (URLs + guards) · <name>.ts (logic) · model.ts (types, collections, indexes)
├── shared/               cross-cutting helpers (see §7)
└── types/                enums.ts · index.ts
scripts/
├── seed-demo.mjs         npm run seed:demo
└── free-port.mjs         npm run predev — frees the port
```

Read a feature top-to-bottom in this order: **`route.ts`** (what URL, who may call it) → **`<name>.ts`** (what it does, what it validates) → **`model.ts`** (the document shape).

---

## 2. Calling the API

**Base URL:** `http://localhost:5000/api` (set by `PORT`; `/api` is the mount point for every router except `/health`).

### 2.1 Response envelope — every response, always

Success (`2xx`):

```json
{ "success": true, "message": "human readable", "data": { } }
```

Failure (`4xx`/`5xx`):

```json
{ "success": false, "message": "what went wrong", "errors": { } }
```

`errors` is only present when there is structured detail (e.g. the allowed values of an enum). **Branch on `success`, never on the HTTP status alone** — though the status is always meaningful too.

### 2.2 Two auth systems

The server has two independent identity systems. This is the single most important thing to understand before calling anything.

**Customers authenticate with Firebase.** The backend never issues a customer a JWT. Your client signs in with the Firebase SDK, then sends the uid on every request:

```
x-firebase-uid: <firebase uid>
```

**Owners, staff and admins authenticate with this server's JWT:**

```
Authorization: Bearer <token>
```

Get a token from `POST /api/auth/login`. Store it and send it as a bearer header. It expires per `JWT_EXPIRES_IN` (default `7d`).

```bash
# 1. log in as the owner
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner.layan@gmail.com","password":"12345678","role":"owner"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# 2. use it
curl -s http://localhost:5000/api/businesses/me -H "Authorization: Bearer $TOKEN"
```

`role` is **required** at login and is checked against the account: asking for the wrong role returns an error rather than a token for the wrong account.

### 2.3 Reading the tables below

| Legend | Meaning |
|---|---|
| **Public** | no header needed |
| **Firebase** | `x-firebase-uid` required |
| **JWT** | `Authorization: Bearer` required |
| **Owner** / **Staff** / **Admin** | that role's JWT |
| **Either** | Firebase customer **or** any JWT; the handler works out who you are |

`Required` body fields are validated and return `400` when missing. Everything not marked required is optional.

### 2.4 Conventions

- **Pagination** — list endpoints accept `?page=` (default 1) and `?limit=` (default 20, **max 100**) and return:
  ```json
  { "items": [], "page": 1, "limit": 20, "total": 0, "totalPages": 1, "hasNextPage": false, "hasPrevPage": false }
  ```
  A few endpoints are unpaginated and return a named key instead (`businesses`, `total` / `promotions`, `total` / `threads`, `total`).
- **IDs** — every `_id` is a 24-character hex string. Pass it as a path param or in the body.
- **Dates** — ISO 8601 UTC, e.g. `2026-09-30T14:00:00.000Z`. `startTime` must be in the future.
- **Deactivation, not deletion** — services, staff and promotions are never removed; they flip `isActive` / `isDeactivated` to `false` so history stays intact.
- **Referenced documents are inlined** — a booking returns `service`, `business`, `customer` and `staff` objects, not just ids.

### 2.5 Error codes

| Status | When |
|---|---|
| `400` | validation failed — missing/!wrong-typed field, bad enum, `startTime` in the past, malformed ObjectId |
| `401` | no credentials, expired/invalid JWT, missing `x-firebase-uid` |
| `403` | authenticated but not allowed (wrong role, not a party to the booking, editing an owner-only field) |
| `404` | no such route, or no such record |
| `409` | duplicate — email already registered, slot clash, unique index violation |
| `500` | unexpected server fault (never leaks a stack trace) |

---

## 3. Endpoint reference

### `auth` — 3 endpoints

Base: `/api/auth`

| Method | Path | Auth | Body | `data` |
|---|---|---|---|---|
| POST | `/register/owner` | Public | **Required:** `ownerName`, `email`, `password` (min 8), `businessName`, `category`, `address`, `city` · Optional: `description` | `{ token, role, business }` · `201` |
| POST | `/login` | Public | **Required:** `email`, `password`, `role` | `{ token, role, businessId }` |
| GET | `/me` | JWT | — | `{ role, profile }` |

`GET /me` is how a dashboard loads itself: it returns the profile already shaped for the role that logged in, so the client never has to guess which collection to read.

### `users` — 5 endpoints

Base: `/api/users` — all customer routes are Firebase-authenticated.

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/sync` | Firebase | **Required:** `name` · Optional: `email`, `phone`, `referredBy`, `genderPreference` | `{ user }` · `201` first time, `200` after |
| GET | `/me` | Firebase | — | `{ user }` |
| PATCH | `/me` | Firebase | `name`, `phone`, `genderPreference`, `favouriteCategories` | `{ user }` |
| PATCH | `/me/favourites` | Firebase | **Required:** `action` = `add`\|`remove` · Optional: `businessId` | `{ user }` |
| GET | `/` | Admin | Query: `q`, `city`, `page`, `limit` | `items` + pagination |

`/sync` is the link between a Firebase account and a Layan profile — call it once right after Firebase sign-in, before anything else. It is idempotent.

Favourites return the **whole updated user**, so a client can patch its cached profile straight from the response and flip the heart without refetching.

### `businesses` — 6 endpoints

Base: `/api/businesses`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| GET | `/` | Public (admin sees all via `?all=true`) | Query: `q`, `category`, `city`, `instantBook`, `sort` (`score` for best-rated first, otherwise newest), `page`, `limit` | `items` + pagination |
| GET | `/me` | Owner | — | `{ business }` |
| PATCH | `/me` | Owner | `businessName`, `description`, `category`, `address`, `city`, `location { latitude, longitude }`, `amenities`, `portfolio`, `instantBookEnabled`, `openingHours` | `{ business }` |
| GET | `/pending` | Admin | — | `{ businesses, total }` |
| PATCH | `/:id/verify` | Admin | **Required:** `status` = `pending`\|`approved`\|`rejected` | `{ business }` |
| GET | `/:id` | Public | — | `{ business }` |

Two things worth knowing:

- **Non-admins only ever see approved businesses.** A brand-new owner's listing is invisible on `GET /` — that is why `GET /me` exists.
- **`GET /:id` inlines the bookable staff roster.** `GET /api/staff` is owner-only, so without this a signed-out visitor could not see who they can book with. Only active staff are returned, and `passwordHash`, `timeOff` and `commissionRate` are stripped.

### `services` — 5 endpoints

Base: `/api/services`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Owner | **Required:** `name`, `category`, `durationMinutes`, `price` · Optional: `description`, `bufferMinutes`, `leadTimeHours`, `cancellationWindowHours` | `{ service }` · `201` |
| GET | `/` | Public | Query: `businessId` (**required** for public callers), `page`, `limit` | `items` + pagination |
| GET | `/:id` | Public | — | `{ service }` |
| PATCH | `/:id` | Owner | same fields as create | `{ service }` |
| DELETE | `/:id` | Owner | — | `{ service }` (deactivated) |

`GET /` **falls back to the JWT's own business** when the caller is an owner or staff member and sends no `businessId` — that is how the owner dashboard lists its own services, including deactivated ones. A public caller with no `businessId` gets `400`.

The business is taken from the JWT, so a `businessId` in the body is ignored.

### `staff` — 5 endpoints

Base: `/api/staff` — the whole module is business-side.

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Owner | **Required:** `name`, `email`, `password` (min 8), `permissionLevel` · Optional: `commissionRate`, `servicesOffered`, `workingHours`, `bio` | `{ staff }` · `201` |
| GET | `/` | Owner | Query: `page`, `limit` | `items` + pagination |
| GET | `/:id` | Owner, Staff | — | `{ staff }` |
| PATCH | `/:id` | Owner, Staff | `name`, `permissionLevel`, `commissionRate`, `servicesOffered`, `workingHours`, `bio`, `isActive` | `{ staff }` |
| DELETE | `/:id` | Owner | — | `{ staff }` (deactivated) |

- `permissionLevel` = `view_only` \| `standard` \| `manager`
- `workingHours` is an **array** of `{ day, start, end }`; `timeOff` is an array of `{ start, end, reason }`
- **A staff member editing their own record may change their hours, time off and bio. Changing `permissionLevel`, `commissionRate` or `servicesOffered` returns `403`** — returning `200` for a silently dropped field would leave the caller believing it landed.
- Creating staff with an email that already exists returns `409`.

### `bookings` — 5 endpoints

Base: `/api/bookings`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Firebase | **Required:** `serviceId`, `startTime` (future ISO) · Optional: `staffId`, `depositAmount`, `paymentMethod`, `consultationForm` | `{ booking }` · `201` |
| GET | `/` | Either | Query: `status`, `businessId`, `page`, `limit` | `items` + pagination |
| GET | `/:id` | Either | — | `{ booking }` |
| PATCH | `/:id/status` | Either | **Required:** `status` · Optional: `paymentMethod`, `amountPaid`, `tip` | `{ booking }` |
| PATCH | `/:id/checkout` | Either | Optional: `amountPaid` (defaults to `totalPrice`), `paymentMethod`, `tip` | `{ booking }` |

- `status` = `pending` \| `confirmed` \| `attended` \| `cancelled` \| `late_cancel` \| `no_show`
- **The business is derived from `serviceId`** — you cannot book service X at business Y. `endTime` and `totalPrice` are computed server-side from the service, so the client cannot lie about them.
- **`GET /` is one route, four scopes:** customer → own bookings, owner → their business's, staff → their own assignments, admin → everything.
- **Status permissions:** owners/staff may set any status; a **customer may only set `cancelled`, `late_cancel` or `no_show`, and only on their own booking.** Without that narrowing a customer could mark a visit `attended` and unlock a review for an appointment that never happened.
- **Double-booking is only checked when you pass `staffId`.** With a specific staff member the server rejects an overlapping interval with `409` and returns `conflictingBookingId`; the check is half-open (`existing.start < newEnd && existing.end > newStart`) and ignores bookings whose status is not blocking. If you **omit `staffId`** ("any available") no conflict check happens at create time — availability is resolved when the business assigns the staff, so a double-booking is possible at that point.

### `waitlist` — 4 endpoints

Base: `/api/waitlist`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Firebase | **Required:** `serviceId` · Optional: `preferredStaffId` | `{ waitlistEntry }` · `201` |
| DELETE | `/:id` | Firebase | — | `{ waitlistEntryId }` |
| GET | `/` | Owner | Query: `status`, `page`, `limit` | `items` + pagination |
| PATCH | `/:id` | Owner | **Required:** `status` | `{ waitlistEntry }` |

`status` = `waiting` \| `notified` \| `booked` \| `expired`

### `reviews` — 3 endpoints

Base: `/api/reviews`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Firebase | **Required:** `bookingId`, `ratings` · Optional: `comment` | `{ review }` · `201` |
| GET | `/` | Public | Query: `businessId` (required), `page`, `limit` | `items` + pagination |
| PATCH | `/:id/reply` | Owner | **Required:** `businessReply` | `{ review }` |

`ratings` is an object and **`overall` (1–5) is required**. The sub-scores `service`, `cleanliness`, `value`, `professionalism` and `punctuality` are optional — any you omit inherits `overall`.

```json
{ "bookingId": "…", "comment": "Great cut", "ratings": { "overall": 5, "service": 5, "value": 4 } }
```

A review can only be written against a booking the customer actually attended, and only once.

### `wallet` — 4 endpoints

Base: `/api/wallet` — Firebase only.

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| GET | `/me` | Firebase | — | `{ wallet }` |
| POST | `/me/topup` | Firebase | **Required:** `amount` (> 0), `type` · Optional: `note` | `{ wallet }` |
| POST | `/me/redeem` | Firebase | **Required:** `amount` (> 0), `type` | `{ wallet }` |
| GET | `/me/transactions` | Firebase | Query: `page`, `limit` | `items` + pagination |

- `type` for **topup** = `loyalty_earn` \| `referral_credit` \| `gift_card_topup`
- `type` for **redeem** = `loyalty_redeem` \| `gift_card_redeem`
- `loyalty_*` moves `loyaltyPoints`; `gift_card_*` moves `giftCardBalance`. Redeeming more than the balance returns `400`.
- The wallet is **created on first read**, so `GET /me` never 404s for a new customer.

### `messages` — 3 endpoints

Base: `/api/messages`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Either | **Required:** `text` · Optional: `businessId`, `customerId` | `{ message }` · `201` |
| GET | `/threads` | Owner, Staff | — | `{ threads, total }` |
| GET | `/` | Either | Query: `businessId`, `customerId` | `{ threadId, messages }` or `{ messages }` |

A thread is simply the pair (customer, business). `GET /messages/threads` powers the inbox list; `GET /messages/?businessId=…&customerId=…` returns one conversation. Empty `text` is `400`.

### `promotions` — 4 endpoints

Base: `/api/promotions`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| POST | `/` | Owner, Admin | **Required:** `type`, `title`, `startDate`, `endDate` · Optional: `description`, `discountPercent` (1–100), `discountAmount` | `{ promotion }` · `201` |
| GET | `/` | Public | Query: `businessId`, `page`, `limit` | `{ promotions, total }` |
| PATCH | `/:id` | Owner, Admin | same as create | `{ promotion }` |
| DELETE | `/:id` | Owner, Admin | — | `{ promotion }` (deactivated) |

`type` = `happy_hour` \| `last_minute_deal` \| `new_customer` \| `returning_customer` \| `birthday` \| `flash_sale` \| `quiet_day`

**A promotion needs at least one of `discountPercent` or `discountAmount`** — `400` otherwise. An admin-created promotion is platform-wide and has no `businessId`.

### `admin` — 5 endpoints

Base: `/api/admin`

| Method | Path | Auth | Body / Query | `data` |
|---|---|---|---|---|
| GET | `/analytics` | Admin | — | `{ businesses, customers, bookings, revenue }` |
| GET | `/fraud-flags` | Admin | — | `{ threshold, flaggedCount, flagged }` |
| POST | `/disputes` | Either | **Required:** `bookingId`, `reason` · Optional: `description`, `businessEvidence`, `customerEvidence` | `{ dispute }` · `201` |
| GET | `/disputes` | Admin | Query: `status`, `page`, `limit` | `items` + pagination |
| PATCH | `/disputes/:id` | Admin | **Required:** `status` · Optional: `resolutionNote` | `{ dispute }` |

`status` = `open` \| `under_review` \| `resolved` \| `rejected`

Only the customer and the business involved in a booking may raise a dispute on it — anyone else gets `403`.

### `health` — 1 endpoint

| Method | Path | Auth | `data` |
|---|---|---|---|
| GET | `/health` | Public | `null` |

Not under `/api`. Use it for readiness checks and uptime monitors.

---

## 4. Worked examples

### Register a salon owner

```bash
curl -s -X POST http://localhost:5000/api/auth/register/owner \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerName": "Alex Owner",
    "email": "alex@example.com",
    "password": "12345678",
    "businessName": "Alex Hair Studio",
    "category": "hair",
    "address": "12 High Street",
    "city": "London",
    "description": "Cuts and colour"
  }'
```

→ `201` `{ "success": true, "message": "Business owner registered successfully", "data": { "token": "…", "role": "owner", "business": { … } } }`

The new business starts as `pending`; an admin must approve it before the public can see it.

### Customer books an appointment (Firebase)

```bash
curl -s -X POST http://localhost:5000/api/bookings \
  -H 'Content-Type: application/json' \
  -H "x-firebase-uid: $FIREBASE_UID" \
  -d '{ "serviceId": "…", "startTime": "2026-10-02T14:00:00.000Z" }'
```

→ `201` `{ "booking": { "_id": "…", "endTime": "…", "totalPrice": 25, "status": "pending", "service": {…}, "business": {…} } }`

### Owner publishes a service

```bash
curl -s -X POST http://localhost:5000/api/services \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "name": "Beard Trim", "category": "hair", "durationMinutes": 30, "price": 20 }'
```

### Customer tops up their gift card

```bash
curl -s -X POST http://localhost:5000/api/wallet/me/topup \
  -H 'Content-Type: application/json' \
  -H "x-firebase-uid: $FIREBASE_UID" \
  -d '{ "type": "gift_card_topup", "amount": 50, "note": "Birthday gift" }'
```

### Admin approves a business

```bash
curl -s -X PATCH http://localhost:5000/api/businesses/<id>/verify \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "status": "approved" }'
```

---

## 5. Who can do what

### 👤 Customer — Firebase

```
sign in with Firebase  →  POST /users/sync  →  x-firebase-uid on everything below
```

Browse and search businesses · view a profile with services, staff and reviews · favourite a salon · book, cancel and view their own bookings · join a waitlist and leave it · review an attended booking · top up / redeem wallet and read transactions · message a business.

### 🏪 Owner — JWT

```
POST /auth/login { role: "owner" }  →  Authorization: Bearer <token>
```

Manage their business profile · CRUD services · invite and manage staff, their hours, time off and commission · see every booking for their salon and set its status · check out and take payment · read and reply to reviews · create promotions · work the waitlist · read message threads.

### 💇 Staff — JWT

```
POST /auth/login { role: "staff" }  →  Authorization: Bearer <token>
```

See only their own assignments · update their own hours, time off and bio · read and reply to message threads. Everything else is `403`.

### 🛡️ Admin — JWT

```
POST /auth/login { role: "admin" }  →  Authorization: Bearer <token>
```

Platform analytics · fraud flags · the business verification queue · all customers · all disputes · platform-wide promotions.

---

## 6. Data model

13 collections, all created/validated from `createIndexes()` at boot:

| Collection | Holds | Key fields |
|---|---|---|
| `admins` | platform admins | `email`, `passwordHash` |
| `businesses` | salons / barbers / nail bars | `businessName`, `email`, `ownerName`, `category`, `address`, `city`, `location{latitude,longitude}`, `verificationStatus`, `amenities`, `portfolio`, `openingHours`, `instantBookEnabled` |
| `users` | customers | `firebaseUid`, `name`, `email`, `phone`, `genderPreference`, `favouriteBusinessIds`, `favouriteCategories` |
| `services` | bookable services | `businessId`, `name`, `category`, `price`, `durationMinutes`, `bufferMinutes`, `leadTimeHours`, `cancellationWindowHours`, `isActive` |
| `staff` | employees | `businessId`, `userId`, `name`, `email`, `passwordHash`, `permissionLevel`, `commissionRate`, `workingHours[]`, `timeOff[]`, `servicesOffered[]`, `isActive` |
| `bookings` | appointments | `businessId`, `customerId`, `serviceId`, `staffId`, `startTime`, `endTime`, `status`, `totalPrice`, `depositAmount`, `slotActive` |
| `waitlistEntries` | queue requests | `businessId`, `customerId`, `serviceId`, `preferredStaffId`, `status` |
| `reviews` | ratings | `businessId`, `customerId`, `bookingId`, `ratings{overall,service,cleanliness,value,professionalism,punctuality}`, `comment`, `businessReply` |
| `wallets` | one per customer | `userId`, `loyaltyPoints`, `giftCardBalance` |
| `walletTransactions` | ledger | `userId`, `type`, `amount`, `balanceAfter`, `note` |
| `messages` | one doc per message | `threadId`, `businessId`, `customerId`, `senderRole`, `text` |
| `promotions` | offers | `businessId`, `type`, `title`, `discountPercent`, `discountAmount`, `startDate`, `endDate`, `isActive` |
| `disputes` | complaints | `bookingId`, `reason`, `description`, `status`, `resolutionNote`, evidence |

Enums live in one place — `src/types/enums.ts`: `Role`, `BookingStatus`, `PaymentMethod`, `VerificationStatus`, `StaffPermissionLevel`, `PromotionType`, `WaitlistStatus`, `DisputeStatus`, `WalletTransactionType`, `MessageSenderRole`, `PromotionCreatedBy`, `GenderPreference`.

---

## 7. Project structure

```
src/
├── index.ts                  boot: connectDB() → createIndexes() → app.listen()
├── app.ts                    middleware order, /health, 12 routers, 404, errorHandler
│
├── modules/
│   ├── auth/                 login, owner registration, role-aware profile
│   ├── users/                Firebase customer profiles + favourites
│   ├── businesses/           listings, search, verification queue
│   ├── services/             services CRUD
│   ├── staff/                staff CRUD, hours, commission
│   ├── bookings/             create, list, status, checkout
│   ├── waitlist/             queue entries
│   ├── reviews/              ratings + owner replies
│   ├── wallet/               balances + transaction ledger
│   ├── messages/             threads
│   ├── promotions/           offers
│   └── admin/                analytics, fraud flags, disputes
│
├── shared/
│   ├── apiError.ts            ApiError.badRequest/unauthorized/forbidden/notFound/conflict
│   ├── apiResponse.ts         sendSuccess · sendPaginated — the only way data leaves
│   ├── asyncHandler.ts        wraps async route handlers so rejections reach errorHandler
│   ├── errorHandler.ts        single global error mapper (incl. Mongo 11000 → 409)
│   ├── auth.middleware.ts     requireAuth · optionalAuth · requireRole(...)
│   ├── firebase.middleware.ts requireFirebaseUser (reads x-firebase-uid)
│   ├── identify.middleware.ts identifyAny + resolveActor — one actor for both auth systems
│   ├── db.ts                  MongoClient, COLLECTIONS, createIndexes()
│   ├── validate.ts            requireString/Number/Date/Id/Enum/Email/Password…
│   ├── helpers.ts             getPagination · buildPaginated · serialize(_many)
│   ├── populate.ts            replaces Mongoose .populate() with batched $in lookups
│   ├── jwt.ts · password.ts   sign/verify, bcrypt hash/compare
│   └── apiError.ts …
│
└── types/
    ├── enums.ts               every enum in the system
    └── index.ts               shared TS types

scripts/
├── seed-demo.mjs              npm run seed:demo
└── free-port.mjs              npm run predev
```

**Module convention** — every feature folder has exactly three files:

| File | Responsibility |
|---|---|
| `route.ts` | URL, HTTP verb, guard middleware. No business logic. |
| `<name>.ts` | validation, permissions, database work, response |
| `model.ts` | TS interface, collection accessor, index definitions, enums |

---

## 8. Scripts and environment

| Command | Does |
|---|---|
| `npm run dev` | dev server with hot reload on `:5000` (`predev` frees the port first) |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | run the compiled server |
| `npm run typecheck` | `tsc --noEmit`, no output files |
| `npm run seed:demo` | idempotent demo accounts + data (server must be running) |

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGODB_URI` | ✅ | — | server refuses to start without it |
| `DB_NAME` | | `layan_db` | database name inside the cluster |
| `PORT` | | `5000` | |
| `JWT_SECRET` | ✅ in prod | — | signs owner/staff/admin tokens |
| `JWT_EXPIRES_IN` | | `7d` | |

---

## 9. Testing

The API was verified end-to-end against a live server and database: **232 assertions across all 52 endpoints**, covering every role, the happy paths, validation failures (`400`), missing/expired auth (`401`), wrong-role access (`403`), missing records (`404`), duplicates (`409`), cross-tenant isolation, booking-slot overlaps, wallet balance limits, and admin permissions. All pass.

Two live-database issues were found and fixed this way — both are worth knowing because they are silent:

1. **A stale unique index on `staff.userId`** (left over from an earlier schema) made it impossible to add a *second* staff member to a business. Dropped.
2. **A stale unique index on `wallets.userId`** made the *second* customer's wallet insert fail, and `getOrCreateWallet` was swallowing the duplicate-key error and returning `null` — so the failure looked like "no wallet" rather than an error. Index dropped, and the catch now rethrows anything that is not a benign read-after-write race.

If you point this server at a database that was created by an older version of the schema, check for leftover indexes before trusting create/delete behaviour.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `MONGODB_URI is not set` | no `.env`, or it is in the wrong folder — copy `.env.example` to `.env` in the repo root |
| `EADDRINUSE` on 5000 | something already owns the port. `npm run dev` frees it automatically; otherwise `lsof -ti:5000 \| xargs kill` |
| `401` on a customer route | the `x-firebase-uid` header is missing. Customers never use a bearer token — call `POST /users/sync` after Firebase sign-in |
| `403` when editing staff | `permissionLevel`, `commissionRate` and `servicesOffered` are owner-only, by design |
| `400 "businessId" query parameter is required` | `GET /api/services` needs `?businessId=` unless you are an owner/staff caller, where it defaults to your own business |
| `400 "startTime" must be in the future` | the API is timezone-aware; send UTC ISO 8601 |
| `409` on a booking | the slot overlaps an existing booking for that service/staff |
| Booking created but not visible to the owner | owners see their own business's bookings; confirm you are logged in as that business's owner |
| Nothing renders in a dashboard | the client is reading the wrong key — list endpoints return `items`, but `/businesses/pending`, `/promotions` and `/messages/threads` return named keys (`businesses`, `promotions`, `threads`) |
| Seed says the customer was skipped | `layan-frontend/.env.local` has no `NEXT_PUBLIC_FIREBASE_API_KEY`; every other account still seeds |

---

## 11. Design notes

Things that were decided deliberately and are easy to trip over:

1. **No ODM.** The official `mongodb` driver is used directly, so validation, timestamps, population and index creation are explicit in `src/shared/`. Nothing is lost — it is just visible. See `validate.ts`, `populate.ts`, `db.ts`.
2. **`location` uses `latitude` / `longitude`**, not `lat` / `lng`, matching the supplied dataset.
3. **`PATCH /bookings/:id/status` is business-side, but a customer may cancel** their own booking (`cancelled`, `late_cancel`, `no_show` only).
4. **`PATCH /bookings/:id/checkout` defaults `amountPaid` to `totalPrice`** — checkout implies the customer settled up, so omitting it means "paid in full".
5. **`GET /businesses/:id` inlines the active staff roster** so signed-out visitors can choose a staff member. `GET /api/staff` stays owner-only.
6. **A staff member sending an owner-only field gets `403`, not a silent no-op.**
7. **Deactivate, never delete** — services, staff and promotions keep their history.
8. **The global error handler never leaks a stack trace**, and maps Mongo duplicate-key (`11000`) to `409` so no raw driver object escapes.
