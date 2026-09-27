import "dotenv/config";
import { createApp } from "./app";
import { closeDB, connectDB, createIndexes } from "./shared/db";

const PORT = Number(process.env.PORT) || 3000;

async function bootstrap(): Promise<void> {
  try {
    await connectDB();
    await createIndexes();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[fatal] could not connect to MongoDB:", error);
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] Layan backend listening on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[server] ${signal} received, shutting down`);
    server.close(async () => {
      await closeDB();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void bootstrap();
