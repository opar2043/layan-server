import "dotenv/config";
import type { IncomingMessage, ServerResponse } from "http";
import app from "../src/app";
import { connectDb } from "../src/shared/db";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "layan";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await connectDb(MONGODB_URI, DB_NAME);
  return app(req, res);
}
