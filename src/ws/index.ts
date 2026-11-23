import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { allowedOrigins } from "../config/env.js";

export function attachRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, { cors: { origin: allowedOrigins, credentials: true } });
  io.on("connection", (socket) => {
    socket.emit("system:ready", { connected: true });
    socket.on("system:ping", (callback?: (payload: { timestamp: string }) => void) => {
      if (typeof callback === "function") callback({ timestamp: new Date().toISOString() });
    });
  });
  return io;
}
