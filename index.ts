import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, type Db } from "mongodb";

const app = express();

app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "layan";
const PORT = Number(process.env.PORT || 3000);

const client = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
let db: Db | null = null;

app.get("/", (_req, res) => {
  res.json({
    message: "Layan API is running",
    database: db?.databaseName ?? "not connected",
  });
});

async function connectToDatabase(): Promise<void> {
  try {
    await client.db(DB_NAME).command({ ping: 1 });
    db = client.db(DB_NAME);
    console.log(`Connected to MongoDB database "${DB_NAME}"`);
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  connectToDatabase();
});

const shutdown = async () => {
  server.close();
  await client.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);