# Layan Server

A clean, modular **Express + TypeScript + MongoDB** backend powering the Layan booking & marketplace platform.

Every database collection from `data.json` gets its own module folder under `src/module/`, exposing standard CRUD over REST. Common helpers live in `src/shared/` and JWT auth lives in `src/auth/`.

---

## Quick Start

```bash
npm install
cp .env.example .env   # then fill in your values
npm run dev            # starts the server at http://localhost:3000
```

### Environment variables

| Variable      | Default                    | Description              |
| ------------- | -------------------------- | ------------------------ |
| `PORT`        | `3000`                     | Server port              |
| `MONGODB_URI` | `mongodb://localhost:27017`| MongoDB connection URI   |
| `DB_NAME`     | `layan`                    | Database name            |
| `JWT_SECRET`  | `layan-dev-secret`         | Secret used to sign JWTs |

---

## Project Structure

```
index.ts                          # Express entry point (middleware, /api wiring, handlers)
src/
├── auth/
│   ├── jwt.ts                    # JWT sign/verify (HS256 via node:crypto)
│   ├── password.ts               # scrypt password hashing
│   └── middleware.ts             # protect + authorize middleware
├── shared/
│   ├── db.ts                     # MongoDB connection + collection accessor
│   ├── crud.ts                   # Generic CRUD handlers (all modules reuse this)
│   ├── response.ts               # sendSuccess / sendError helpers
│   └── utils.ts                  # id + timestamp helpers
├── routes/
│   └── index.ts                  # Mounts every module under /api/<folder>
└── module/
    ├── auth/                     # POST /api/auth/register, /api/auth/login, GET /api/auth/me
    ├── users/                    # GET/POST /api/users, GET/PUT/DELETE /api/users/:id
    ├── business/
    ├── ...                       # one folder per collection — each has route.ts + logic file
```

### Module file pattern

```
src/module/<name>/
├── route.ts       # Express Router: maps HTTP verbs to the logic functions
└── <name>.ts      # Logic functions (findAll, findById, create, update, remove)
```

---

## Response format

Every endpoint returns a consistent JSON envelope:

```json
// Success
{ "success": true,  "data": { ... } }

// Error
{ "success": false, "message": "Reason for the failure" }
```

Standard HTTP status codes are used (`200`, `201`, `400`, `401`, `403`, `404`, `500`).

---

## Authentication

Auth is JWT-based (HS256). Login/register returns a token; send it as a `Bearer` token to protected routes.

### Register — `POST /api/auth/register`

Request:

```json
{
  "email": "owner1@layan.test",
  "password": "secret123",
  "phone": "+447700900001",
  "user_type": "owner"
}
```

Response (`201`):

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "_id": "app-user-8ef5df09",
      "email": "owner1@layan.test",
      "phone": "+447700900001",
      "password_hash": "6671a0...:09f952...",
      "user_type": "owner",
      "created_at": "2026-09-01T09:00:00.000Z"
    }
  }
}
```

### Login — `POST /api/auth/login`

Request:

```json
{ "email": "owner1@layan.test", "password": "secret123" }
```

Response (`200`):

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": { "_id": "user-001", "email": "owner1@layan.test" }
  }
}
```

### Current user — `GET /api/auth/me`

```bash
curl http://localhost:3000/api/auth/me -H "Authorization: Bearer <token>"
```

Response (`200`):

```json
{
  "success": true,
  "data": {
    "_id": "user-001",
    "email": "owner1@layan.test",
    "phone": "+447700900001",
    "user_type": "owner",
    "created_at": "2026-09-01T09:00:00Z"
  }
}
```

---

## Standard CRUD endpoints

Every resource module exposes the same routes:

| Method | Endpoint         | Description                      |
| ------ | ---------------- | -------------------------------- |
| GET    | `/api/<folder>`          | List all documents               |
| GET    | `/api/<folder>/:id`      | Get one document by `_id`        |
| POST   | `/api/<folder>`          | Create a document                |
| PUT    | `/api/<folder>/:id`      | Update a document                |
| DELETE | `/api/<folder>/:id`      | Delete a document                |

Example:


---

## All modules & collections

| Endpoint path                    | Collection                    |
| -------------------------------- | ----------------------------- |
| `/api/auth`                      | — (register / login / me)     |
| `/api/users`                     | `app_user`                    |
| `/api/business`                  | `business`                    |
| `/api/location`                  | `location`                    |
| `/api/customer`                  | `customer`                    |
| `/api/staff`                     | `staff`                       |
| `/api/staff-availability`        | `staff_availability`          |
| `/api/staff-time-off`            | `staff_time_off`              |
| `/api/service-category`          | `service_category`            |
| `/api/service`                   | `service`                     |
| `/api/staff-service`             | `staff_service`               |
| `/api/portfolio-media`           | `portfolio_media`             |
| `/api/appointment`               | `appointment`                 |
| `/api/appointment-service`       | `appointment_service`         |
| `/api/appointment-status-history`| `appointment_status_history`  |
| `/api/waitlist-entry`            | `waitlist_entry`              |
| `/api/last-minute-slot`          | `last_minute_slot`            |
| `/api/payment`                   | `payment`                     |
| `/api/payment-event`             | `payment_event`               |
| `/api/customer-wallet`           | `customer_wallet`             |
| `/api/wallet-transaction`        | `wallet_transaction`          |
| `/api/gift-card`                 | `gift_card`                   |
| `/api/membership-plan`           | `membership_plan`             |
| `/api/customer-membership`       | `customer_membership`         |
| `/api/service-package`           | `service_package`             |
| `/api/customer-package`          | `customer_package`            |
| `/api/inventory-item`            | `inventory_item`              |
| `/api/stock-movement`            | `stock_movement`              |
| `/api/customer-business-profile` | `customer_business_profile`   |
| `/api/consultation-form-template`| `consultation_form_template`  |
| `/api/consultation-form-submission` | `consultation_form_submission` |
| `/api/loyalty-program`           | `loyalty_program`             |
| `/api/loyalty-account`           | `loyalty_account`             |
| `/api/loyalty-transaction`       | `loyalty_transaction`         |
| `/api/referral`                  | `referral`                    |
| `/api/referral-redemption`       | `referral_redemption`         |
| `/api/customer-favourite`        | `customer_favourite`          |
| `/api/message-thread`            | `message_thread`              |
| `/api/message`                   | `message`                     |
| `/api/review`                    | `review`                      |
| `/api/business-badge`            | `business_badge`              |
| `/api/fraud-flag`                | `fraud_flag`                  |
| `/api/dispute`                   | `dispute`                     |
| `/api/promotion`                 | `promotion`                   |
| `/api/promotion-redemption`      | `promotion_redemption`        |
| `/api/marketing-campaign`        | `marketing_campaign`          |
| `/api/campaign-recipient`        | `campaign_recipient`          |
| `/api/admin-action-log`          | `admin_action_log`            |

---

## Document schemas (demo JSON)

Below is one sample document per collection, matching the shape the API accepts and returns.

### 1. Users — `app_user`

```json
{
  "_id": "user-001",
  "email": "owner1@layan.test",
  "phone": "+447700900001",
  "password_hash": "$2b$12$seedhash001",
  "user_type": "owner",
  "created_at": "2026-09-01T09:00:00Z"
}
```

`user_type` is one of: `owner`, `staff`, `customer`, `admin`.

### 2. Business — `business`

```json
{
  "_id": "business-001",
  "owner_user_id": "user-001",
  "legal_name": "London Grooming Ltd",
  "display_name": "London Grooming",
  "slug": "london-grooming",
  "category": "barber",
  "description": "Modern barber studio in London.",
  "cover_image_url": "https://example.com/barber-cover.jpg",
  "profile_image_url": "https://example.com/barber-profile.jpg",
  "cancellation_policy": {
    "window_hours": 24,
    "fee_type": "percentage",
    "fee_value": 50
  },
  "verification_status": "business",
  "business_score": 92.5,
  "is_active": true,
  "created_at": "2026-09-01T09:00:00Z",
  "updated_at": "2026-09-01T09:00:00Z"
}
```

### 3. Location — `location`

```json
{
  "_id": "location-001",
  "business_id": "business-001",
  "name": "Central London Branch",
  "address_line1": "10 Baker Street",
  "address_line2": "",
  "city": "London",
  "postcode": "W1U 3BW",
  "country": "UK",
  "lat": 51.5225,
  "lng": -0.1571,
  "opening_hours": {
    "mon": [{ "open": "09:00", "close": "19:00" }],
    "tue": [{ "open": "09:00", "close": "19:00" }],
    "wed": [{ "open": "09:00", "close": "19:00" }],
    "thu": [{ "open": "09:00", "close": "20:00" }],
    "fri": [{ "open": "09:00", "close": "20:00" }],
    "sat": [{ "open": "10:00", "close": "18:00" }],
    "sun": []
  },
  "mobile_service_radius_km": 10,
  "is_active": true,
  "created_at": "2026-09-01T09:00:00Z"
}
```

### 4. Customer — `customer`

```json
{
  "_id": "user-003",
  "first_name": "Rijoan",
  "last_name": "Rashid",
  "gender_pref": "any",
  "marketing_opt_in": true,
  "created_at": "2026-09-01T09:10:00Z"
}
```

`gender_pref` is one of: `any`, `male`, `female`.

### 5. Staff — `staff`

```json
{
  "_id": "staff-001",
  "user_id": "user-002",
  "business_id": "business-001",
  "location_id": "location-001",
  "display_name": "Alex Carter",
  "role": "senior_barber",
  "commission_pct": 40,
  "permissions": { "can_manage_bookings": true },
  "is_active": true
}
```

### 6. Staff Availability — `staff_availability`

```json
{
  "_id": "availability-001",
  "staff_id": "staff-001",
  "weekday": 1,
  "start_time": "09:00",
  "end_time": "17:00"
}
```

### 7. Staff Time Off — `staff_time_off`

```json
{
  "_id": "timeoff-001",
  "staff_id": "staff-001",
  "start_at": "2026-09-21T13:00:00Z",
  "end_at": "2026-09-21T15:00:00Z",
  "reason": "Personal appointment"
}
```

### 8. Service Category — `service_category`

```json
{ "_id": "category-001", "name": "Hair" }
```

### 9. Service — `service`

```json
{
  "_id": "service-001",
  "business_id": "business-001",
  "category_id": "category-001",
  "name": "Classic Haircut",
  "description": "Classic men's haircut.",
  "duration_minutes": 45,
  "buffer_before_minutes": 5,
  "buffer_after_minutes": 5,
  "base_price_minor": 2500,
  "lead_time_hours": 1,
  "is_instant_book": true,
  "is_active": true
}
```

> Prices are in minor units (pence/cents). `2500` = £25.00.

### 10. Staff Service — `staff_service`

```json
{
  "_id": "staff-001_service-001",
  "staff_id": "staff-001",
  "service_id": "service-001",
  "price_override_minor": 2800,
  "duration_override_minutes": 45
}
```

### 11. Portfolio Media — `portfolio_media`

```json
{
  "_id": "media-001",
  "business_id": "business-001",
  "staff_id": "staff-001",
  "service_id": "service-001",
  "media_url": "https://example.com/haircut-1.jpg",
  "media_type": "image",
  "before_after_pair_url": "https://example.com/haircut-before-after.jpg",
  "tags": ["fade", "classic"],
  "created_at": "2026-09-01T10:00:00Z"
}
```

### 12. Appointment — `appointment`

```json
{
  "_id": "appointment-001",
  "business_id": "business-001",
  "location_id": "location-001",
  "staff_id": "staff-001",
  "customer_id": "user-003",
  "start_at": "2026-09-21T10:00:00Z",
  "end_at": "2026-09-21T10:45:00Z",
  "status": "confirmed",
  "source_channel": "marketplace",
  "total_price_minor": 2800,
  "deposit_required_minor": 500,
  "recurrence_rule": null,
  "group_booking_id": null,
  "notes": "Regular haircut",
  "created_at": "2026-09-15T09:00:00Z"
}
```

`status` is one of: `pending`, `confirmed`, `attended`, `cancelled`, `no_show`.

### 13. Appointment Service — `appointment_service`

```json
{
  "_id": "appointment-service-001",
  "appointment_id": "appointment-001",
  "service_id": "service-001",
  "price_minor": 2800,
  "duration_minutes": 45
}
```

### 14. Appointment Status History — `appointment_status_history`

```json
{
  "_id": "status-history-001",
  "appointment_id": "appointment-001",
  "old_status": "pending",
  "new_status": "confirmed",
  "changed_by": "user-001",
  "changed_at": "2026-09-15T09:01:00Z"
}
```

### 15. Waitlist Entry — `waitlist_entry`

```json
{
  "_id": "waitlist-001",
  "business_id": "business-001",
  "customer_id": "user-003",
  "service_id": "service-001",
  "staff_id": "staff-001",
  "preferred_date_range": { "start": "2026-09-25", "end": "2026-09-27" },
  "preferred_time_range": { "start": "2026-09-25T09:00:00Z", "end": "2026-09-27T18:00:00Z" },
  "status": "active",
  "created_at": "2026-09-18T09:00:00Z"
}
```

### 16. Last Minute Slot — `last_minute_slot`

```json
{
  "_id": "lastminute-001",
  "business_id": "business-001",
  "staff_id": "staff-001",
  "service_id": "service-001",
  "start_at": "2026-09-24T16:00:00Z",
  "discount_pct": 20,
  "is_booked": false
}
```

### 17. Payment — `payment`

```json
{
  "_id": "payment-001",
  "appointment_id": "appointment-001",
  "business_id": "business-001",
  "customer_id": "user-003",
  "psp_payment_intent_id": "pi_seed_001",
  "amount_minor": 500,
  "platform_fee_minor": 50,
  "tip_minor": 0,
  "type": "deposit",
  "status": "succeeded",
  "created_at": "2026-09-15T09:02:00Z"
}
```

`type`: `deposit` | `full_payment` · `status`: `succeeded` | `pending` | `failed` | `refunded`.

### 18. Payment Event — `payment_event`

```json
{
  "_id": "payment-event-001",
  "payment_id": "payment-001",
  "event_type": "payment_intent.succeeded",
  "raw_payload": { "id": "evt_seed_001", "status": "succeeded" },
  "received_at": "2026-09-15T09:03:00Z"
}
```

### 19. Customer Wallet — `customer_wallet`

```json
{
  "_id": "user-003",
  "customer_id": "user-003",
  "balance_minor": 2500
}
```

### 20. Wallet Transaction — `wallet_transaction`

```json
{
  "_id": "wallet-tx-001",
  "customer_id": "user-003",
  "amount_minor": 2500,
  "source": "refund_credit",
  "reference_id": "payment-001",
  "created_at": "2026-09-15T10:00:00Z"
}
```

`source`: `refund_credit` | `referral_credit` | `loyalty_redeem`.

### 21. Gift Card — `gift_card`

```json
{
  "_id": "giftcard-001",
  "business_id": "business-001",
  "code": "LAYAN-HAIR-001",
  "initial_value_minor": 5000,
  "remaining_value_minor": 5000,
  "purchased_by": "user-003",
  "recipient_customer_id": "customer-002",
  "delivery_at": "2026-09-20T09:00:00Z",
  "expires_at": "2027-09-20T09:00:00Z"
}
```

`business_id` can be `null` for an all-marketplace gift card.

### 22. Membership Plan — `membership_plan`

```json
{
  "_id": "plan-001",
  "business_id": "business-001",
  "name": "Barber Monthly",
  "price_minor": 3000,
  "billing_interval": "monthly",
  "included_services": { "service_ids": ["service-001"], "sessions": 1 },
  "discount_pct": 10
}
```

### 23. Customer Membership — `customer_membership`

```json
{
  "_id": "membership-001",
  "customer_id": "user-003",
  "plan_id": "plan-001",
  "status": "active",
  "psp_subscription_id": "sub_seed_001",
  "current_period_end": "2026-10-01T00:00:00Z"
}
```

### 24. Service Package — `service_package`

```json
{
  "_id": "package-001",
  "business_id": "business-001",
  "service_id": "service-001",
  "name": "5 Haircuts",
  "session_count": 5,
  "price_minor": 12000
}
```

### 25. Customer Package — `customer_package`

```json
{
  "_id": "customer-package-001",
  "customer_id": "user-003",
  "package_id": "package-001",
  "sessions_remaining": 4,
  "purchased_at": "2026-09-10T09:00:00Z",
  "expires_at": "2027-03-10T09:00:00Z"
}
```

### 26. Inventory Item — `inventory_item`

```json
{
  "_id": "inventory-001",
  "business_id": "business-001",
  "location_id": "location-001",
  "sku": "BRB-SHAM-001",
  "name": "Barber Shampoo",
  "supplier": "Pro Hair Supply",
  "cost_minor": 700,
  "sell_price_minor": 1500,
  "quantity": 20,
  "low_stock_threshold": 5
}
```

### 27. Stock Movement — `stock_movement`

```json
{
  "_id": "stock-move-001",
  "inventory_item_id": "inventory-001",
  "delta": -2,
  "reason": "used_in_service",
  "reference_id": "appointment-001",
  "created_at": "2026-09-21T10:50:00Z"
}
```

### 28. Customer Business Profile — `customer_business_profile`

```json
{
  "_id": "cbp-001",
  "customer_id": "user-003",
  "business_id": "business-001",
  "total_spend_minor": 8500,
  "visit_count": 3,
  "avg_spend_minor": 2833,
  "last_visit_at": "2026-09-21T10:45:00Z",
  "no_show_count": 0,
  "cancellation_count": 0,
  "predicted_rebook_cycle_days": 30,
  "notes": "Prefers short sides.",
  "allergies": null,
  "marketing_permission": true
}
```

### 29. Consultation Form Template — `consultation_form_template`

```json
{
  "_id": "template-001",
  "business_id": "business-001",
  "name": "Hair Consultation",
  "schema": {
    "fields": [
      { "name": "hair_type", "type": "text" },
      { "name": "desired_style", "type": "text" }
    ]
  }
}
```

### 30. Consultation Form Submission — `consultation_form_submission`

```json
{
  "_id": "submission-001",
  "template_id": "template-001",
  "customer_id": "user-003",
  "appointment_id": "appointment-001",
  "answers": { "hair_type": "straight", "desired_style": "classic fade" },
  "signature_url": "https://example.com/signature-001.png",
  "submitted_at": "2026-09-21T09:30:00Z"
}
```

### 31. Loyalty Program — `loyalty_program`

```json
{
  "_id": "loyalty-program-001",
  "business_id": "business-001",
  "rules": {
    "points_per_pound": 1,
    "reward_thresholds": [{ "points": 100, "reward_minor": 500 }]
  }
}
```

### 32. Loyalty Account — `loyalty_account`

```json
{
  "_id": "loyalty-account-001",
  "customer_id": "user-003",
  "business_id": "business-001",
  "points_balance": 120
}
```

### 33. Loyalty Transaction — `loyalty_transaction`

```json
{
  "_id": "loyalty-tx-001",
  "customer_id": "user-003",
  "business_id": "business-001",
  "points_delta": 50,
  "reason": "appointment_completed",
  "reference_id": "appointment-001",
  "created_at": "2026-09-21T11:00:00Z"
}
```

### 34. Referral — `referral`

```json
{
  "_id": "referral-001",
  "referrer_customer_id": "user-003",
  "business_id": "business-001",
  "code": "RIJOAN001",
  "reward_referrer_minor": 1000,
  "reward_referee_minor": 500
}
```

### 35. Referral Redemption — `referral_redemption`

```json
{
  "_id": "redemption-001",
  "referral_id": "referral-001",
  "referee_customer_id": "customer-002",
  "qualifying_appointment_id": "appointment-002",
  "redeemed_at": "2026-09-22T12:30:00Z"
}
```

### 36. Customer Favourite — `customer_favourite`

```json
{
  "_id": "favourite-001",
  "customer_id": "user-003",
  "target_type": "business",
  "target_id": "business-001",
  "created_at": "2026-09-10T09:00:00Z"
}
```

`target_type`: `business` | `staff` | `service`.

### 37. Message Thread — `message_thread`

```json
{
  "_id": "thread-001",
  "business_id": "business-001",
  "customer_id": "user-003",
  "appointment_id": "appointment-001"
}
```

### 38. Message — `message`

```json
{
  "_id": "message-001",
  "thread_id": "thread-001",
  "sender_type": "customer",
  "sender_id": "user-003",
  "body": "Can I arrive 5 minutes early?",
  "image_url": null,
  "sent_at": "2026-09-20T10:00:00Z"
}
```

### 39. Review — `review`

```json
{
  "_id": "review-001",
  "appointment_id": "appointment-001",
  "business_id": "business-001",
  "customer_id": "user-003",
  "overall_rating": 5,
  "service_rating": 5,
  "cleanliness_rating": 5,
  "value_rating": 4,
  "professionalism_rating": 5,
  "punctuality_rating": 5,
  "comment": "Great service.",
  "photo_urls": [],
  "business_reply": "Thank you!",
  "is_verified_booking": true,
  "created_at": "2026-09-21T12:00:00Z"
}
```

### 40. Business Badge — `business_badge`

```json
{
  "_id": "business-001_verified",
  "business_id": "business-001",
  "badge_type": "verified",
  "awarded_at": "2026-09-05T09:00:00Z"
}
```

### 41. Fraud Flag — `fraud_flag`

```json
{
  "_id": "fraud-001",
  "entity_type": "customer",
  "entity_id": "user-003",
  "flag_type": "multiple_accounts",
  "severity": "low",
  "details": { "reason": "Test seed flag" },
  "status": "dismissed",
  "created_at": "2026-09-10T09:00:00Z"
}
```

### 42. Dispute — `dispute`

```json
{
  "_id": "dispute-001",
  "payment_id": "payment-001",
  "raised_by": "user-003",
  "reason": "Service issue",
  "status": "open",
  "resolution": null,
  "created_at": "2026-09-21T15:00:00Z"
}
```

### 43. Promotion — `promotion`

```json
{
  "_id": "promotion-001",
  "business_id": "business-001",
  "type": "happy_hour",
  "discount_pct": 15,
  "rules": { "weekdays": [1, 2, 3], "hours": ["14:00", "16:00"] },
  "active_from": "2026-09-20T00:00:00Z",
  "active_to": "2026-10-01T00:00:00Z"
}
```

### 44. Promotion Redemption — `promotion_redemption`

```json
{
  "_id": "promotion-redemption-001",
  "promotion_id": "promotion-001",
  "appointment_id": "appointment-001",
  "discount_applied_minor": 420
}
```

### 45. Marketing Campaign — `marketing_campaign`

```json
{
  "_id": "campaign-001",
  "business_id": "business-001",
  "channel": "sms",
  "template": "Your next haircut is waiting.",
  "segment_definition": { "visit_count_gte": 2 },
  "status": "scheduled",
  "scheduled_at": "2026-09-25T09:00:00Z",
  "is_ai_generated": false
}
```

### 46. Campaign Recipient — `campaign_recipient`

```json
{
  "_id": "recipient-001",
  "campaign_id": "campaign-001",
  "customer_id": "user-003",
  "status": "queued",
  "sent_at": null
}
```

### 47. Admin Action Log — `admin_action_log`

```json
{
  "_id": "admin-action-001",
  "admin_id": "user-001",
  "action": "verify_business",
  "entity_type": "business",
  "entity_id": "business-001",
  "details": { "status": "business" },
  "created_at": "2026-09-05T09:00:00Z"
}
```

---

## Conventions

- **IDs** — `_id` is always a string (e.g. `user-001`), matching `data.json`. New documents get an auto-generated id like `business-a1b2c3d4` if you don't supply one.
- **Money** — all monetary fields use `*_minor` suffix (minor units, e.g. pence).
- **Dates** — ISO 8601 strings (e.g. `2026-09-21T10:00:00Z`).
- **Join keys** — relationships use `*_id` fields: `business_id`, `customer_id`, `staff_id`, `service_id`, `appointment_id`, etc.

## Scripts

```bash
npm run dev     # start the dev server with auto-reload
npm run build   # compile TypeScript
npm start       # run the compiled server (node index.js)
```