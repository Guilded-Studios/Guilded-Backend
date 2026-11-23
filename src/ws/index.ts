import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { allowedOrigins } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { SESSION_COOKIE } from "../lib/session.js";
function sessionTokenFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}
export function attachRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, { cors: { origin: allowedOrigins, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = sessionTokenFromCookie(socket.handshake.headers.cookie);
      if (!token || token.length > 256) return next(new Error("Authentication required"));
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const session = await prisma.session.findUnique({ where: { tokenHash }, select: { userId: true, expiresAt: true } });
      if (!session || session.expiresAt <= new Date()) return next(new Error("Invalid or expired session"));
      socket.data.userId = session.userId;
      next();
    } catch { next(new Error("Unable to authenticate connection")); }
  });
  io.on("connection", (socket) => {
    socket.emit("system:ready", { connected: true, userId: socket.data.userId });
    socket.on("system:ping", (callback?: (payload: { timestamp: string }) => void) => {
      if (typeof callback === "function") callback({ timestamp: new Date().toISOString() });
    });
  });
  return io;
}
