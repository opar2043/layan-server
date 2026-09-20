import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { connectDb, disconnectDb } from "./src/shared/db";
import { sendError } from "./src/shared/response";
import routes from "./src/routes";

const app = express();

app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "layan";
const PORT = Number(process.env.PORT || 3000);

app.get("/", (_req, res) => {
  res.json({ message: "Layan API is running" });
});

app.use("/api", routes);

app.use((_req, res) => sendError(res, 404, "Endpoint not found"));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  sendError(res, 500, "Internal server error");
});

const server = app.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  try {
    await connectDb(MONGODB_URI, DB_NAME);
    console.log(`Connected to MongoDB database "${DB_NAME}"`);
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
});

const shutdown = async () => {
  server.close();
  await disconnectDb();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);