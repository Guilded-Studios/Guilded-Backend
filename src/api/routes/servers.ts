import { randomBytes } from "node:crypto";
import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
export const serversRouter: ExpressRouter = Router();
serversRouter.use(requireAuth);
const serverParams = z.object({ serverId: z.string().min(1) });
async function membership(serverId: string, userId: string) {
  return prisma.serverMember.findUnique({ where: { serverId_userId: { serverId, userId } } });
}
function canManage(role: string) { return role === "OWNER" || role === "ADMIN"; }

serversRouter.get("/", async (request, response, next) => {
  try {
    const servers = await prisma.server.findMany({
      where: { members: { some: { userId: request.auth!.userId } } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, name: true, description: true, ownerId: true, createdAt: true,
        _count: { select: { members: true, channels: true } }
      }
    });
    response.json({ servers });
  } catch (error) { next(error); }
});

serversRouter.post("/", async (request, response, next) => {
  try {
    const parsed = z.object({
      name: z.string().trim().min(2).max(64),
      description: z.string().trim().max(500).optional()
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Server name must be 2–64 characters", details: parsed.error.flatten().fieldErrors } });
      return;
    }
    const server = await prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          inviteCode: randomBytes(9).toString("base64url"),
          ownerId: request.auth!.userId
        }
      });
      await tx.serverMember.create({ data: { serverId: created.id, userId: request.auth!.userId, role: "OWNER" } });
      const channel = await tx.channel.create({ data: { serverId: created.id, name: "general", type: "TEXT", position: 0 } });
      return { ...created, channels: [channel] };
    });
    response.status(201).json({ server });
  } catch (error) { next(error); }
});

serversRouter.post("/join", async (request, response, next) => {
  try {
    const parsed = z.object({ inviteCode: z.string().trim().min(6).max(64) }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A valid invite code is required" } });
      return;
    }
    const server = await prisma.server.findUnique({ where: { inviteCode: parsed.data.inviteCode } });
    if (!server) {
      response.status(404).json({ error: { code: "INVITE_NOT_FOUND", message: "That invite is invalid or expired" } });
      return;
    }
    await prisma.serverMember.upsert({
      where: { serverId_userId: { serverId: server.id, userId: request.auth!.userId } },
      create: { serverId: server.id, userId: request.auth!.userId, role: "MEMBER" },
      update: {}
    });
    response.json({ server: { id: server.id, name: server.name, description: server.description } });
  } catch (error) { next(error); }
});

serversRouter.get("/:serverId", async (request, response, next) => {
  try {
    const params = serverParams.safeParse(request.params);
    if (!params.success) { response.status(400).json({ error: { code: "INVALID_SERVER_ID", message: "Invalid server ID" } }); return; }
    if (!await membership(params.data.serverId, request.auth!.userId)) {
      response.status(404).json({ error: { code: "SERVER_NOT_FOUND", message: "Server not found" } });
      return;
    }
    const server = await prisma.server.findUnique({
      where: { id: params.data.serverId },
      select: {
        id: true, name: true, description: true, ownerId: true, inviteCode: true, createdAt: true,
        channels: { orderBy: { position: "asc" }, select: { id: true, name: true, type: true, position: true } },
        _count: { select: { members: true } }
      }
    });
    response.json({ server });
  } catch (error) { next(error); }
});

serversRouter.patch("/:serverId", async (request, response, next) => {
  try {
    const params = serverParams.safeParse(request.params);
    const parsed = z.object({
      name: z.string().trim().min(2).max(64).optional(),
      description: z.string().trim().max(500).nullable().optional()
    }).strict().safeParse(request.body);
    if (!params.success || !parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide a valid server update" } });
      return;
    }
    const member = await membership(params.data.serverId, request.auth!.userId);
    if (!member || !canManage(member.role)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You cannot manage this server" } });
      return;
    }
    const server = await prisma.server.update({ where: { id: params.data.serverId }, data: parsed.data });
    response.json({ server });
  } catch (error) { next(error); }
});

serversRouter.post("/:serverId/leave", async (request, response, next) => {
  try {
    const params = serverParams.safeParse(request.params);
    if (!params.success) { response.status(400).json({ error: { code: "INVALID_SERVER_ID", message: "Invalid server ID" } }); return; }
    const member = await membership(params.data.serverId, request.auth!.userId);
    if (!member) { response.status(404).json({ error: { code: "SERVER_NOT_FOUND", message: "Server not found" } }); return; }
    if (member.role === "OWNER") {
      response.status(409).json({ error: { code: "OWNER_CANNOT_LEAVE", message: "Transfer ownership or delete the server before leaving" } });
      return;
    }
    await prisma.serverMember.delete({ where: { id: member.id } });
    response.status(204).end();
  } catch (error) { next(error); }
});

serversRouter.post("/:serverId/channels", async (request, response, next) => {
  try {
    const params = serverParams.safeParse(request.params);
    const parsed = z.object({
      name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      type: z.enum(["TEXT", "ANNOUNCEMENT"]).default("TEXT")
    }).strict().safeParse(request.body);
    if (!params.success || !parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide a valid channel name and type" } });
      return;
    }
    const member = await membership(params.data.serverId, request.auth!.userId);
    if (!member || !canManage(member.role)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You cannot create channels in this server" } });
      return;
    }
    const position = await prisma.channel.count({ where: { serverId: params.data.serverId } });
    const channel = await prisma.channel.create({
      data: { serverId: params.data.serverId, name: parsed.data.name.toLowerCase(), type: parsed.data.type, position }
    });
    response.status(201).json({ channel });
  } catch (error) { next(error); }
});
