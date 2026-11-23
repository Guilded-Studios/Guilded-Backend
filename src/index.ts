import { createServer } from "node:http";
import { app } from "./api/app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { attachRealtime } from "./ws/index.js";

const httpServer = createServer(app);
attachRealtime(httpServer);
httpServer.listen(env.PORT, env.HOST, () => {
  console.log(`Guilded backend listening on http://${env.HOST}:${env.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down Guilded backend`);
  httpServer.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
