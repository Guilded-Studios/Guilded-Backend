import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { getRealtimeServer } from "../../lib/realtime.js";
import { requireAuth } from "../middleware/auth.js";
export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.get("/:channelId/messages", async (request, response, next) => {
  try {
    const params = z.object({ channelId: z.string().min(1) }).safeParse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().optional() }).safeParse(request.query);
    if (!params.success || !query.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid channel or pagination parameters" } });
      return;
    }
    const channel = await prisma.channel.findUnique({ where: { id: params.data.channelId }, select: { serverId: true } });
    if (!channel || !await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: channel.serverId, userId: request.auth!.userId } },
      select: { id: true }
    })) {
      response.status(404).json({ error: { code: "CHANNEL_NOT_FOUND", message: "Channel not found" } });
      return;
    }
    const messages = await prisma.message.findMany({
      where: { channelId: params.data.channelId },
      take: query.data.limit,
      ...(query.data.before ? { cursor: { id: query.data.before }, skip: 1 } : {}),
      orderBy: { createdAt: "desc" },
      include: { author: { select: { id: true, username: true, displayName: true } } }
    });
    response.json({ messages: messages.reverse(), hasMore: messages.length === query.data.limit });
  } catch (error) { next(error); }
});

messagesRouter.post("/:channelId/messages", async (request, response, next) => {
  try {
    const params = z.object({ channelId: z.string().min(1) }).safeParse(request.params);
    const parsed = z.object({ content: z.string().trim().min(1).max(4000) }).strict().safeParse(request.body);
    if (!params.success || !parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Message content must be between 1 and 4000 characters" } });
      return;
    }
    const channel = await prisma.channel.findUnique({ where: { id: params.data.channelId }, select: { id: true, serverId: true } });
    if (!channel || !await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: channel.serverId, userId: request.auth!.userId } },
      select: { id: true }
    })) {
      response.status(404).json({ error: { code: "CHANNEL_NOT_FOUND", message: "Channel not found" } });
      return;
    }
    const message = await prisma.message.create({
      data: { channelId: channel.id, authorId: request.auth!.userId, content: parsed.data.content },
      include: { author: { select: { id: true, username: true, displayName: true } } }
    });
    getRealtimeServer()?.to("channel:" + channel.id).emit("message:new", message);
    response.status(201).json({ message });
  } catch (error) { next(error); }
});
