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
  const activeUsers = new Map<string, { id: string; username: string; tag: string; displayName: string | null; status: 'ONLINE' | 'IDLE' | 'DND' | 'OFFLINE'; sockets: Set<string> }>();
  io.on("connection", async (socket) => {
    const profile = await prisma.user.findUnique({
      where: { id: socket.data.userId },
      select: { id: true, username: true, tag: true, displayName: true }
    });
    if (!profile || !socket.connected) return;
    let active = activeUsers.get(profile.id);
    const wasOffline = !active;
    if (!active) {
      active = { ...profile, status: 'ONLINE', sockets: new Set<string>() };
      activeUsers.set(profile.id, active);
    }
    active.sockets.add(socket.id);
    socket.emit("presence:snapshot", Array.from(activeUsers.values()).map(({ sockets, ...person }) => person));
    if (wasOffline) io.emit("presence:update", { ...profile, status: active.status });
    socket.emit("system:ready", { connected: true, userId: socket.data.userId });
    socket.on("presence:set", (value: unknown) => {
      if (value !== "ONLINE" && value !== "IDLE" && value !== "DND" && value !== "INVISIBLE") return;
      const current = activeUsers.get(profile.id);
      if (!current) return;
      current.status = value === "INVISIBLE" ? "OFFLINE" : value;
      io.emit("presence:update", { id: profile.id, username: profile.username, tag: profile.tag, displayName: profile.displayName, status: current.status });
    });
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
          include: { customRole: true }
        });
        if (!member) { callback?.({ ok: false }); return; }
        if (member.role !== "OWNER" && member.role !== "ADMIN") {
          const permissions = member.customRole?.permissions as Record<string, boolean> | undefined;
          if (permissions?.READ_MESSAGES === false) { callback?.({ ok: false }); return; }
          if (permissions?.READ_MESSAGES !== true) {
            const overrides = await prisma.channelPermissionOverride.findMany({
              where: { channelId, OR: [{ memberId: member.id }, ...(member.roleId ? [{ roleId: member.roleId }] : [])] }
            });
            if (overrides.some(override => (override.deny as Record<string, boolean>).READ_MESSAGES === true)) {
              callback?.({ ok: false });
              return;
            }
          }
        }
        await socket.join("channel:" + channelId);
        callback?.({ ok: true });
      } catch { callback?.({ ok: false }); }
    });
    socket.on("channel:leave", (channelId: unknown) => {
      if (typeof channelId === "string" && channelId.length <= 128) void socket.leave("channel:" + channelId);
    });
    socket.on("conversation:join", async (conversationId: unknown, callback?: (result: { ok: boolean }) => void) => {
      if (typeof conversationId !== "string" || conversationId.length > 128) { callback?.({ ok: false }); return; }
      try {
        const member = await prisma.conversationMember.findUnique({
          where: { conversationId_userId: { conversationId, userId: socket.data.userId } },
          select: { id: true }
        });
        if (!member) { callback?.({ ok: false }); return; }
        await socket.join("conversation:" + conversationId);
        callback?.({ ok: true });
      } catch { callback?.({ ok: false }); }
    });
    socket.on("conversation:leave", (conversationId: unknown) => {
      if (typeof conversationId === "string" && conversationId.length <= 128) void socket.leave("conversation:" + conversationId);
    });

    socket.on("system:ping", (callback?: (payload: { timestamp: string }) => void) => {
      if (typeof callback === "function") callback({ timestamp: new Date().toISOString() });
    });
    socket.on("disconnect", () => {
      const current = activeUsers.get(profile.id);
      if (!current) return;
      current.sockets.delete(socket.id);
      if (current.sockets.size === 0) {
        activeUsers.delete(profile.id);
        io.emit("presence:update", { id: profile.id, status: "OFFLINE" });
      }
    });
  });
  return io;
}
