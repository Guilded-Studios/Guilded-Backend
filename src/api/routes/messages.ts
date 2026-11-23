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

messagesRouter.patch("/:channelId/messages/:messageId", async (request, response, next) => {
  try {
    const params = z.object({ channelId: z.string().min(1), messageId: z.string().min(1) }).safeParse(request.params);
    const parsed = z.object({ content: z.string().trim().min(1).max(4000) }).strict().safeParse(request.body);
    if (!params.success || !parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Message content must be between 1 and 4000 characters" } });
      return;
    }
    const message = await prisma.message.findUnique({
      where: { id: params.data.messageId },
      include: { channel: { select: { id: true, serverId: true } } }
    });
    if (!message || message.channelId !== params.data.channelId) {
      response.status(404).json({ error: { code: "MESSAGE_NOT_FOUND", message: "Message not found" } });
      return;
    }
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: message.channel.serverId, userId: request.auth!.userId } }
    });
    if (!member) {
      response.status(404).json({ error: { code: "MESSAGE_NOT_FOUND", message: "Message not found" } });
      return;
    }
    if (message.authorId !== request.auth!.userId) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You can only edit your own messages" } });
      return;
    }
    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { content: parsed.data.content, editedAt: new Date() },
      include: { author: { select: { id: true, username: true, displayName: true } } }
    });
    getRealtimeServer()?.to("channel:" + message.channelId).emit("message:update", updated);
    response.json({ message: updated });
  } catch (error) { next(error); }
});

messagesRouter.delete("/:channelId/messages/:messageId", async (request, response, next) => {
  try {
    const params = z.object({ channelId: z.string().min(1), messageId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid message identifier" } });
      return;
    }
    const message = await prisma.message.findUnique({
      where: { id: params.data.messageId },
      include: { channel: { select: { serverId: true } } }
    });
    if (!message || message.channelId !== params.data.channelId) {
      response.status(404).json({ error: { code: "MESSAGE_NOT_FOUND", message: "Message not found" } });
      return;
    }
    const member = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: message.channel.serverId, userId: request.auth!.userId } }
    });
    if (!member) {
      response.status(404).json({ error: { code: "MESSAGE_NOT_FOUND", message: "Message not found" } });
      return;
    }
    const canModerate = member.role === "OWNER" || member.role === "ADMIN" || member.role === "MODERATOR";
    if (message.authorId !== request.auth!.userId && !canModerate) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You cannot delete this message" } });
      return;
    }
    await prisma.message.delete({ where: { id: message.id } });
    getRealtimeServer()?.to("channel:" + message.channelId).emit("message:delete", { id: message.id, channelId: message.channelId });
    response.status(204).end();
  } catch (error) { next(error); }
});
