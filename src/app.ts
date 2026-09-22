import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { sendError } from "./shared/response";
import routes from "./routes";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "Layan API is running" });
});

app.use("/api", routes);

app.use((_req, res) => sendError(res, 404, "Endpoint not found"));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  sendError(res, 500, "Internal server error");
});

export default app;
