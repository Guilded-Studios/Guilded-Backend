import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { allowedOrigins } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { SESSION_COOKIE } from "../lib/session.js";
import { setRealtimeServer } from "../lib/realtime.js";
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
  setRealtimeServer(io);
  io.on("connection", (socket) => {
    socket.emit("system:ready", { connected: true, userId: socket.data.userId });
    socket.on("channel:join", async (channelId: unknown, callback?: (result: { ok: boolean }) => void) => {
      if (typeof channelId !== "string" || channelId.length > 128) {
        callback?.({ ok: false });
        return;
      }
      try {
        const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
        if (!channel) { callback?.({ ok: false }); return; }
        const member = await prisma.serverMember.findUnique({
          where: { serverId_userId: { serverId: channel.serverId, userId: socket.data.userId } },
          select: { id: true }
        });
        if (!member) { callback?.({ ok: false }); return; }
        await socket.join("channel:" + channelId);
        callback?.({ ok: true });
      } catch { callback?.({ ok: false }); }
    });
    socket.on("channel:leave", (channelId: unknown) => {
      if (typeof channelId === "string" && channelId.length <= 128) void socket.leave("channel:" + channelId);
    });
    socket.on("system:ping", (callback?: (payload: { timestamp: string }) => void) => {
      if (typeof callback === "function") callback({ timestamp: new Date().toISOString() });
    });
  });
  return io;
}
