/**
 * Seeds one demo account per role so the app can be walked end to end.
 *
 * Owner/staff/admin authenticate against the backend with a JWT. Customers
 * authenticate with Firebase, so a real Firebase Auth user is created over the
 * Identity Toolkit REST API and then linked to a Mongo record via `users/sync`.
 *
 * Safe to re-run: every account is upserted by email.
 */
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";

const PASSWORD = "12345678";
const DOMAIN = "layan@gmail.com";
const API = "http://localhost:3000/api";

// This script lives in scripts/, so the backend .env is one level up.
const backendEnv = readFileSync(new URL("../.env", import.meta.url), "utf8");
const frontendEnv = readFileSync(
  new URL("../../layan-frontend/.env.local", import.meta.url),
  "utf8"
);
const readVar = (text, key) =>
  text
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`))
    ?.split(`${key}=`)[1]
    .trim();

const MONGO_URI = readVar(backendEnv, "MONGODB_URI");
const DB_NAME = readVar(backendEnv, "DB_NAME") || "layan_db";
const FIREBASE_KEY = readVar(frontendEnv, "NEXT_PUBLIC_FIREBASE_API_KEY");

const email = (role) => `${role}.${DOMAIN}`;
const label = (role) => `${role}.layan@gmail.com`;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const now = new Date();
  const hash = await bcrypt.hash(PASSWORD, 10);

  const businesses = db.collection("businesses");
  const admins = db.collection("admins");
  const staff = db.collection("staff");
  const services = db.collection("services");
  const users = db.collection("users");

  // ---------------------------------------------------------------- admin
  await admins.updateOne(
    { email: email("admin") },
    {
      $set: { name: "Platform Admin", email: email("admin"), passwordHash: hash, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  // ------------------------------------------------------- owner + business
  const ownerEmail = email("owner");
  let business = await businesses.findOne({ email: ownerEmail });
  if (!business) {
    const businessId = new ObjectId();
    business = {
      _id: businessId,
      ownerName: "Olivia Owner",
      email: ownerEmail,
      passwordHash: hash,
      businessName: "Layan Demo Salon",
      category: "Beauty",
      description: "A demo salon with services, staff, bookings and reviews already in place.",
      location: {
        address: "22 Demo High Street",
        city: "London",
        latitude: 51.5074,
        longitude: -0.1278,
        mobileServiceRadiusKm: 0,
      },
      openingHours: "Monday: 09:00 - 18:00\nTuesday: 09:00 - 18:00\nWednesday: 09:00 - 18:00",
      coverImage: "",
      profileImage: "",
      portfolio: [],
      amenities: ["Walk-ins welcome", "Card payments", "Wheelchair accessible"],
      cancellationPolicy: "Free cancellation up to 24 hours before your appointment.",
      instantBookEnabled: true,
      // Approved so it appears in public search and can take bookings.
      verificationStatus: "approved",
      isBusinessVerified: true,
      isIdentityVerified: true,
      badges: ["demo"],
      masterAccountId: null,
      bookingUrl: null,
      businessScore: 4.8,
      createdAt: now,
      updatedAt: now,
    };
    await businesses.insertOne(business);
  }
  const businessId = business._id;

  // -------------------------------------------------------------- services
  const serviceSeeds = [
    { name: "Signature Haircut", category: "Hair", durationMinutes: 45, price: 40 },
    { name: "Colour & Gloss", category: "Hair", durationMinutes: 120, price: 95 },
    { name: "Deep Tissue Massage", category: "Massage", durationMinutes: 60, price: 65 },
    { name: "Manicure", category: "Nails", durationMinutes: 30, price: 25 },
  ];
  const serviceIds = [];
  for (const seed of serviceSeeds) {
    let doc = await services.findOne({ businessId, name: seed.name });
    if (!doc) {
      const result = await services.insertOne({
        ...seed,
        businessId,
        description: `${seed.name} at Layan Demo Salon.`,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      doc = { _id: result.insertedId, ...seed };
    }
    serviceIds.push(doc._id);
  }

  // ----------------------------------------------------------------- staff
  const staffEmail = email("staff");
  let staffDoc = await staff.findOne({ email: staffEmail });
  if (!staffDoc) {
    const result = await staff.insertOne({
      businessId,
      name: "Sam Stylist",
      email: staffEmail,
      passwordHash: hash,
      permissionLevel: "manager",
      servicesOffered: serviceIds.slice(0, 2),
      workingHours: [
        { day: "monday", start: "09:00", end: "17:00" },
        { day: "tuesday", start: "09:00", end: "17:00" },
        { day: "wednesday", start: "09:00", end: "17:00" },
      ],
      timeOff: [],
      commissionRate: 10,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    staffDoc = { _id: result.insertedId, email: staffEmail };
  }

  // -------------------------------------------------------------- customer
  // Customers cannot be password-seeded: the backend never issues them a JWT.
  // A real Firebase Auth user is created, then `users/sync` links the record.
  const customerEmail = email("customer");
  let customerUid = null;
  if (FIREBASE_KEY) {
    const created = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: customerEmail, password: PASSWORD, returnSecureToken: true }),
      }
    );
    const body = await created.json();
    if (body?.localId) {
      customerUid = body.localId;
    } else if (body?.error?.message?.includes("EMAIL_EXISTS")) {
      // Already registered — sign in instead to recover the uid.
      const signedIn = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: customerEmail, password: PASSWORD, returnSecureToken: true }),
        }
      );
      const signInBody = await signedIn.json();
      customerUid = signInBody?.localId ?? null;
    } else {
      console.warn(`  ! Firebase signup failed: ${body?.error?.message}`);
    }
  }

  let customerLinked = false;
  if (customerUid) {
    const res = await fetch(`${API}/users/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-firebase-uid": customerUid },
      body: JSON.stringify({
        name: "Chris Customer",
        email: customerEmail,
        phone: "07000 000123",
      }),
    });
    customerLinked = res.ok;

    // Give the demo customer a favourite so the favourites tab is not empty.
    // The endpoint toggles one business at a time via { businessId, action }.
    if (res.ok) {
      await fetch(`${API}/users/me/favourites`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-firebase-uid": customerUid },
        body: JSON.stringify({ businessId: businessId.toHexString(), action: "add" }),
      });
    }
  }

  // ------------------------------------------------- pending owner (review)
  const pendingEmail = email("pending");
  await businesses.updateOne(
    { email: pendingEmail },
    {
      $set: {
        ownerName: "Parker Pending",
        email: pendingEmail,
        passwordHash: hash,
        businessName: "Newcomer Nails",
        category: "Nails",
        description: "A brand-new listing waiting for admin verification.",
        location: {
          address: "5 Review Lane",
          city: "Manchester",
          latitude: 53.4808,
          longitude: -2.2426,
          mobileServiceRadiusKm: 0,
        },
        openingHours: "Monday: 10:00 - 17:00",
        portfolio: [],
        amenities: [],
        instantBookEnabled: false,
        verificationStatus: "pending",
        isBusinessVerified: false,
        isIdentityVerified: false,
        badges: [],
        masterAccountId: null,
        businessScore: 0,
        createdAt: now,
        updatedAt: now,
      },
      $setOnInsert: {},
    },
    { upsert: true }
  );

  await client.close();

  console.log(`\nSeeded into ${DB_NAME}  (password for all: ${PASSWORD})\n`);
  console.log(`  ADMIN     ${label("admin")}`);
  console.log(`  OWNER     ${label("owner")}   business: Layan Demo Salon (approved)`);
  console.log(`  STAFF     ${label("staff")}   Sam Stylist`);
  console.log(
    `  CUSTOMER  ${label("customer")}   ${
      customerLinked ? "Firebase account created and linked" : "NOT linked — see note below"
    }`
  );
  console.log(`  PENDING   ${label("pending")}  Newcomer Nails (awaiting admin approval)\n`);
  if (!customerLinked) {
    console.log("  Note: the customer account could not be created automatically.");
    console.log("  Sign up at /register on the Customer tab using the same email and");
    console.log("  password — the backend links it on first login.\n");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
