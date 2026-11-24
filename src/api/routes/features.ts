import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { getRealtimeServer } from "../../lib/realtime.js";
import { requireAuth } from "../middleware/auth.js";

export const featuresRouter: ExpressRouter = Router();
featuresRouter.use(requireAuth);
const id = z.string().min(1).max(128);
const memberOf = (serverId: string, userId: string) => prisma.serverMember.findUnique({ where: { serverId_userId: { serverId, userId } } });
const elevated = (role?: string | null) => role === "OWNER" || role === "ADMIN";
async function audit(serverId: string, actorId: string, action: string, targetId?: string, details?: unknown) {
  await prisma.auditLog.create({ data: { serverId, actorId, action, targetId, ...(details === undefined ? {} : { details: details as never }) } });
}
async function can(serverId: string, userId: string, permission: string) {
  const member = await memberOf(serverId, userId);
  if (!member) return false;
  if (member.role === "OWNER") return true;
  if (member.role === "ADMIN") return true;
  if (!member.roleId) return false;
  const role = await prisma.serverRole.findFirst({ where: { id: member.roleId, serverId } });
  const permissions = role?.permissions as Record<string, boolean> | undefined;
  return permissions?.[permission] === true;
}

// Configurable server roles
featuresRouter.get("/servers/:serverId/roles", async (req, res, next) => {
  try {
    if (!await memberOf(req.params.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Server not found" } });
    const roles = await prisma.serverRole.findMany({ where: { serverId: req.params.serverId }, orderBy: { position: "desc" } });
    res.json({ roles });
  } catch (e) { next(e); }
});
featuresRouter.post("/servers/:serverId/roles", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_ROLES")) return res.status(403).json({ error: { message: "You cannot manage roles" } });
    const body = z.object({ name: z.string().trim().min(2).max(32), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), permissions: z.record(z.boolean()).default({}), position: z.number().int().min(0).max(1000).default(0) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid role details" } });
    const role = await prisma.serverRole.create({ data: { serverId: req.params.serverId, ...body.data } });
    await audit(req.params.serverId, req.auth!.userId, "ROLE_CREATED", role.id, { name: role.name });
    res.status(201).json({ role });
  } catch (e) { next(e); }
});
featuresRouter.patch("/servers/:serverId/roles/:roleId", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_ROLES")) return res.status(403).json({ error: { message: "You cannot manage roles" } });
    const body = z.object({ name: z.string().trim().min(2).max(32).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), permissions: z.record(z.boolean()).optional(), position: z.number().int().min(0).max(1000).optional() }).strict().safeParse(req.body);
    if (!body.success || !Object.keys(body.data || {}).length) return res.status(400).json({ error: { message: "Invalid role update" } });
    const role = await prisma.serverRole.updateMany({ where: { id: req.params.roleId, serverId: req.params.serverId }, data: body.data });
    if (!role.count) return res.status(404).json({ error: { message: "Role not found" } });
    const updated = await prisma.serverRole.findUnique({ where: { id: req.params.roleId } });
    await audit(req.params.serverId, req.auth!.userId, "ROLE_UPDATED", req.params.roleId);
    res.json({ role: updated });
  } catch (e) { next(e); }
});
featuresRouter.delete("/servers/:serverId/roles/:roleId", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_ROLES")) {
      return res.status(403).json({ error: { message: "You cannot manage roles" } });
    }
    const role = await prisma.serverRole.findFirst({
      where: { id: req.params.roleId, serverId: req.params.serverId },
      select: { id: true, name: true }
    });
    if (!role) return res.status(404).json({ error: { message: "Role not found" } });
    await prisma.serverRole.delete({ where: { id: role.id } });
    await audit(req.params.serverId, req.auth!.userId, "ROLE_DELETED", role.id, { name: role.name });
    res.status(204).end();
  } catch (e) { next(e); }
});

featuresRouter.put("/servers/:serverId/members/:memberId/role", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_ROLES")) return res.status(403).json({ error: { message: "You cannot manage roles" } });
    const body = z.object({ roleId: id.nullable() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid role assignment" } });
    if (body.data.roleId && !await prisma.serverRole.findFirst({ where: { id: body.data.roleId, serverId: req.params.serverId } })) return res.status(404).json({ error: { message: "Role not found" } });
    const updated = await prisma.serverMember.updateMany({ where: { id: req.params.memberId, serverId: req.params.serverId, role: "MEMBER" }, data: { roleId: body.data.roleId } });
    if (!updated.count) return res.status(404).json({ error: { message: "Member not found or role is protected" } });
    await audit(req.params.serverId, req.auth!.userId, "MEMBER_ROLE_CHANGED", req.params.memberId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Real channel categories and channel permission overrides
featuresRouter.get("/servers/:serverId/categories", async (req, res, next) => {
  try {
    if (!await memberOf(req.params.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Server not found" } });
    const categories = await prisma.channelCategory.findMany({ where: { serverId: req.params.serverId }, include: { channels: { orderBy: { position: "asc" } } }, orderBy: { position: "asc" } });
    res.json({ categories });
  } catch (e) { next(e); }
});
featuresRouter.post("/servers/:serverId/categories", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_CHANNELS")) return res.status(403).json({ error: { message: "You cannot manage channels" } });
    const body = z.object({ name: z.string().trim().min(1).max(64) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Category name is required" } });
    const category = await prisma.channelCategory.create({ data: { serverId: req.params.serverId, name: body.data.name, position: await prisma.channelCategory.count({ where: { serverId: req.params.serverId } }) } });
    await audit(req.params.serverId, req.auth!.userId, "CATEGORY_CREATED", category.id);
    res.status(201).json({ category });
  } catch (e) { next(e); }
});
featuresRouter.delete("/servers/:serverId/categories/:categoryId", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_CHANNELS")) return res.status(403).json({ error: { message: "You cannot manage channels" } });
    const category = await prisma.channelCategory.findFirst({ where: { id: req.params.categoryId, serverId: req.params.serverId }, select: { id: true } });
    if (!category) return res.status(404).json({ error: { message: "Category not found" } });
    await prisma.$transaction([
      prisma.channel.updateMany({ where: { serverId: req.params.serverId, categoryId: category.id }, data: { categoryId: null } }),
      prisma.channelCategory.delete({ where: { id: category.id } })
    ]);
    await audit(req.params.serverId, req.auth!.userId, "CATEGORY_DELETED", category.id);
    res.status(204).end();
  } catch (e) { next(e); }
});
featuresRouter.patch("/servers/:serverId/channels/:channelId/category", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_CHANNELS")) return res.status(403).json({ error: { message: "You cannot manage channels" } });
    const body = z.object({ categoryId: id.nullable() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid category" } });
    if (body.data.categoryId && !await prisma.channelCategory.findFirst({ where: { id: body.data.categoryId, serverId: req.params.serverId } })) return res.status(404).json({ error: { message: "Category not found" } });
    const result = await prisma.channel.updateMany({ where: { id: req.params.channelId, serverId: req.params.serverId }, data: { categoryId: body.data.categoryId } });
    if (!result.count) return res.status(404).json({ error: { message: "Channel not found" } });
    await audit(req.params.serverId, req.auth!.userId, "CHANNEL_CATEGORY_CHANGED", req.params.channelId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
featuresRouter.put("/servers/:serverId/channels/:channelId/permissions", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_CHANNELS")) return res.status(403).json({ error: { message: "You cannot manage channel permissions" } });
    const body = z.object({ roleId: id.nullable().optional(), memberId: id.nullable().optional(), allow: z.record(z.boolean()), deny: z.record(z.boolean()) }).strict().refine(v => Boolean(v.roleId) !== Boolean(v.memberId)).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Choose exactly one role or member and provide permission rules" } });
    const channel = await prisma.channel.findFirst({ where: { id: req.params.channelId, serverId: req.params.serverId } });
    if (!channel) return res.status(404).json({ error: { message: "Channel not found" } });
    if (body.data.roleId && !await prisma.serverRole.findFirst({ where: { id: body.data.roleId, serverId: req.params.serverId } })) return res.status(404).json({ error: { message: "Role not found" } });
    if (body.data.memberId && !await prisma.serverMember.findFirst({ where: { id: body.data.memberId, serverId: req.params.serverId } })) return res.status(404).json({ error: { message: "Member not found" } });
    const existing = await prisma.channelPermissionOverride.findFirst({ where: { channelId: channel.id, roleId: body.data.roleId ?? null, memberId: body.data.memberId ?? null } });
    const override = existing
      ? await prisma.channelPermissionOverride.update({ where: { id: existing.id }, data: { allow: body.data.allow, deny: body.data.deny } })
      : await prisma.channelPermissionOverride.create({ data: { channelId: channel.id, roleId: body.data.roleId, memberId: body.data.memberId, allow: body.data.allow, deny: body.data.deny } });
    await audit(req.params.serverId, req.auth!.userId, "CHANNEL_PERMISSIONS_UPDATED", channel.id);
    res.status(201).json({ override });
  } catch (e) { next(e); }
});

// Friends and private conversations
featuresRouter.get("/friends", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const [incoming, outgoing, accepted] = await Promise.all([
      prisma.friendRequest.findMany({ where: { receiverId: userId, status: "PENDING" }, include: { sender: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } }),
      prisma.friendRequest.findMany({ where: { senderId: userId, status: "PENDING" }, include: { receiver: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } }),
      prisma.friendRequest.findMany({ where: { OR: [{ senderId: userId }, { receiverId: userId }], status: "ACCEPTED" }, include: { sender: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } }, receiver: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } })
    ]);
    res.json({ incoming, outgoing, friends: accepted.map(f => f.senderId === userId ? f.receiver : f.sender) });
  } catch (e) { next(e); }
});
featuresRouter.post("/friends/requests", async (req, res, next) => {
  try {
    const body = z.object({ username: z.string().trim().min(3).max(37) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { code: "INVALID_USERNAME", message: "Enter a username with its four-digit #tag, such as player#4821." } });

    const identity = /^@?([a-z0-9_]{3,32})#([0-9]{4})$/i.exec(body.data.username);
    if (!identity) return res.status(400).json({ error: { code: "INVALID_USERNAME_FORMAT", message: "Use the full username and four-digit tag in the format username#1234." } });

    const target = await prisma.user.findUnique({
      where: { username_tag: { username: identity[1]!.toLowerCase(), tag: identity[2]! } },
      select: { id: true }
    });
    if (!target) return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "No Guilded account matches that username and tag. Check both parts and try again." } });
    if (target.id === req.auth!.userId) return res.status(400).json({ error: { code: "CANNOT_ADD_SELF", message: "You cannot send a friend request to your own account." } });

    const requests = await prisma.friendRequest.findMany({
      where: { OR: [{ senderId: req.auth!.userId, receiverId: target.id }, { senderId: target.id, receiverId: req.auth!.userId }] },
      orderBy: { updatedAt: "desc" }
    });
    const outgoing = requests.find(item => item.senderId === req.auth!.userId);
    const incoming = requests.find(item => item.senderId === target.id);

    if (requests.some(item => item.status === "ACCEPTED")) {
      return res.status(409).json({ error: { code: "ALREADY_FRIENDS", message: "You are already friends with this account." } });
    }
    if (outgoing?.status === "PENDING") {
      return res.status(409).json({ error: { code: "REQUEST_ALREADY_SENT", message: "A friend request is already waiting for this person." } });
    }
    if (incoming?.status === "PENDING") {
      const accepted = await prisma.friendRequest.update({ where: { id: incoming.id }, data: { status: "ACCEPTED" } });
      return res.json({ request: accepted, autoAccepted: true });
    }

    // Reopen a declined request instead of creating a second, reversed relationship row.
    const declined = outgoing || incoming;
    const request = declined
      ? await prisma.friendRequest.update({
          where: { id: declined.id },
          data: { senderId: req.auth!.userId, receiverId: target.id, status: "PENDING" }
        })
      : await prisma.friendRequest.create({ data: { senderId: req.auth!.userId, receiverId: target.id } });

    return res.status(201).json({ request });
  } catch (e) { next(e); }
});
featuresRouter.patch("/friends/requests/:requestId", async (req, res, next) => {
  try {
    const body = z.object({ status: z.enum(["ACCEPTED", "DECLINED"]) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid friend request action" } });
    const result = await prisma.friendRequest.updateMany({ where: { id: req.params.requestId, receiverId: req.auth!.userId, status: "PENDING" }, data: { status: body.data.status } });
    if (!result.count) return res.status(404).json({ error: { message: "Friend request not found" } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
featuresRouter.get("/conversations", async (req, res, next) => {
  try {
    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId: req.auth!.userId } } },
      orderBy: { updatedAt: "desc" },
      include: {
        members: { include: { user: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } },
        messages: { take: 1, orderBy: { createdAt: "desc" }, include: { author: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } }
      }
    });
    res.json({ conversations });
  } catch (e) { next(e); }
});
featuresRouter.post("/conversations", async (req, res, next) => {
  try {
    const groupBody = z.object({ userIds: z.array(id).min(2).max(24) }).strict().safeParse(req.body);
    if (groupBody.success) {
      const userIds = [...new Set(groupBody.data.userIds)];
      if (userIds.length < 2 || userIds.length !== groupBody.data.userIds.length || userIds.includes(req.auth!.userId)) {
        return res.status(400).json({ error: { message: "Choose at least two different friends." } });
      }
      const friends = await prisma.friendRequest.findMany({
        where: { status: "ACCEPTED", OR: userIds.map(friendId => ({ senderId: req.auth!.userId, receiverId: friendId })).concat(userIds.map(friendId => ({ senderId: friendId, receiverId: req.auth!.userId }))) },
        select: { senderId: true, receiverId: true }
      });
      const acceptedIds = new Set(friends.map(friend => friend.senderId === req.auth!.userId ? friend.receiverId : friend.senderId));
      if (userIds.some(friendId => !acceptedIds.has(friendId))) return res.status(403).json({ error: { message: "Group chats can only include your accepted friends." } });
      const conversation = await prisma.conversation.create({
        data: { members: { create: [req.auth!.userId, ...userIds].map(userId => ({ userId })) } },
        include: { members: { include: { user: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } } }
      });
      return res.status(201).json({ conversation });
    }
    const body = z.object({ userId: id }).strict().safeParse(req.body);
    if (!body.success || body.data.userId === req.auth!.userId) return res.status(400).json({ error: { message: "Choose another user" } });
    const target = await prisma.user.findUnique({ where: { id: body.data.userId }, select: { id: true } });
    if (!target) return res.status(404).json({ error: { message: "User not found" } });
    const existing = await prisma.conversation.findFirst({ where: { AND: [{ members: { some: { userId: req.auth!.userId } } }, { members: { some: { userId: target.id } } }, { members: { every: { userId: { in: [req.auth!.userId, target.id] } } } }] }, include: { members: { include: { user: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } } } });
    const conversation = existing ?? await prisma.conversation.create({ data: { members: { create: [{ userId: req.auth!.userId }, { userId: target.id }] } }, include: { members: { include: { user: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } } } });
    res.status(existing ? 200 : 201).json({ conversation });
  } catch (e) { next(e); }
});
featuresRouter.get("/conversations/:conversationId/messages", async (req, res, next) => {
  try {
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: req.params.conversationId, userId: req.auth!.userId } } });
    if (!member) return res.status(404).json({ error: { message: "Conversation not found" } });
    const messages = await prisma.directMessage.findMany({ where: { conversationId: req.params.conversationId }, orderBy: { createdAt: "asc" }, take: 100, include: { author: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } }, attachments: true, reactions: { select: { emoji: true, userId: true } } } });
    res.json({ messages });
  } catch (e) { next(e); }
});
featuresRouter.post("/conversations/:conversationId/messages", async (req, res, next) => {
  try {
    const body = z.object({ content: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Message must be 1–4000 characters" } });
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: req.params.conversationId, userId: req.auth!.userId } } });
    if (!member) return res.status(404).json({ error: { message: "Conversation not found" } });
    const message = await prisma.directMessage.create({ data: { conversationId: req.params.conversationId, authorId: req.auth!.userId, content: body.data.content }, include: { author: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } } });
    await prisma.conversation.update({ where: { id: req.params.conversationId }, data: { updatedAt: new Date() } });
    getRealtimeServer()?.to("conversation:" + req.params.conversationId).emit("direct-message:new", { conversationId: req.params.conversationId, message });
    res.status(201).json({ message });
  } catch (e) { next(e); }
});

featuresRouter.patch("/conversations/:conversationId/messages/:messageId", async (req, res, next) => {
  try {
    const body = z.object({ content: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Message must be 1–4000 characters" } });
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: req.params.conversationId, userId: req.auth!.userId } } });
    if (!member) return res.status(404).json({ error: { message: "Conversation not found" } });
    const existing = await prisma.directMessage.findFirst({ where: { id: req.params.messageId, conversationId: req.params.conversationId } });
    if (!existing) return res.status(404).json({ error: { message: "Message not found" } });
    if (existing.authorId !== req.auth!.userId) return res.status(403).json({ error: { message: "You can only edit your own messages" } });
    const message = await prisma.directMessage.update({
      where: { id: existing.id },
      data: { content: body.data.content, editedAt: new Date() },
      include: { author: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } }, attachments: true, reactions: { select: { emoji: true, userId: true } } }
    });
    getRealtimeServer()?.to("conversation:" + req.params.conversationId).emit("direct-message:update", { conversationId: req.params.conversationId, message });
    res.json({ message });
  } catch (e) { next(e); }
});

featuresRouter.delete("/conversations/:conversationId/messages/:messageId", async (req, res, next) => {
  try {
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: req.params.conversationId, userId: req.auth!.userId } } });
    if (!member) return res.status(404).json({ error: { message: "Conversation not found" } });
    const existing = await prisma.directMessage.findFirst({ where: { id: req.params.messageId, conversationId: req.params.conversationId } });
    if (!existing) return res.status(404).json({ error: { message: "Message not found" } });
    if (existing.authorId !== req.auth!.userId) return res.status(403).json({ error: { message: "You can only delete your own messages" } });
    await prisma.directMessage.delete({ where: { id: existing.id } });
    getRealtimeServer()?.to("conversation:" + req.params.conversationId).emit("direct-message:delete", { conversationId: req.params.conversationId, id: existing.id });
    res.status(204).end();
  } catch (e) { next(e); }
});

featuresRouter.post("/conversations/:conversationId/messages/:messageId/reactions", async (req, res, next) => {
  try {
    const body = z.object({ emoji: z.string().trim().min(1).max(32) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Choose a valid reaction" } });
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: req.params.conversationId, userId: req.auth!.userId } } });
    if (!member) return res.status(404).json({ error: { message: "Conversation not found" } });
    const message = await prisma.directMessage.findFirst({ where: { id: req.params.messageId, conversationId: req.params.conversationId } });
    if (!message) return res.status(404).json({ error: { message: "Message not found" } });
    const existing = await prisma.directMessageReaction.findUnique({ where: { directMessageId_userId_emoji: { directMessageId: message.id, userId: req.auth!.userId, emoji: body.data.emoji } } });
    if (existing) await prisma.directMessageReaction.delete({ where: { id: existing.id } });
    else await prisma.directMessageReaction.create({ data: { directMessageId: message.id, userId: req.auth!.userId, emoji: body.data.emoji } });
    const updated = await prisma.directMessage.findUnique({
      where: { id: message.id },
      include: { author: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } }, attachments: true, reactions: { select: { emoji: true, userId: true } } }
    });
    if (updated) getRealtimeServer()?.to("conversation:" + req.params.conversationId).emit("direct-message:update", { conversationId: req.params.conversationId, message: updated });
    res.json({ reactions: updated?.reactions || [] });
  } catch (e) { next(e); }
});

// Events and join applications
featuresRouter.get("/servers/:serverId/events", async (req, res, next) => {
  try {
    if (!await memberOf(req.params.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Server not found" } });
    const events = await prisma.event.findMany({ where: { serverId: req.params.serverId }, orderBy: { startsAt: "asc" } });
    res.json({ events });
  } catch (e) { next(e); }
});
featuresRouter.post("/servers/:serverId/events", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_EVENTS")) return res.status(403).json({ error: { message: "You cannot create events" } });
    const body = z.object({ title: z.string().trim().min(2).max(100), description: z.string().max(2000).optional(), location: z.string().max(200).optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime().optional() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid event details" } });
    const event = await prisma.event.create({ data: { serverId: req.params.serverId, creatorId: req.auth!.userId, ...body.data, startsAt: new Date(body.data.startsAt), ...(body.data.endsAt ? { endsAt: new Date(body.data.endsAt) } : {}) } });
    await audit(req.params.serverId, req.auth!.userId, "EVENT_CREATED", event.id);
    res.status(201).json({ event });
  } catch (e) { next(e); }
});
featuresRouter.post("/servers/:serverId/applications", async (req, res, next) => {
  try {
    const body = z.object({ answers: z.record(z.string().max(2000)) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Provide application answers" } });
    if (await memberOf(req.params.serverId, req.auth!.userId)) return res.status(409).json({ error: { message: "You are already a member" } });
    const application = await prisma.serverApplication.upsert({ where: { serverId_userId: { serverId: req.params.serverId, userId: req.auth!.userId } }, create: { serverId: req.params.serverId, userId: req.auth!.userId, answers: body.data.answers }, update: { answers: body.data.answers, status: "PENDING", reviewedAt: null, reviewedById: null } });
    res.status(201).json({ application });
  } catch (e) { next(e); }
});
featuresRouter.get("/servers/:serverId/applications", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_APPLICATIONS")) return res.status(403).json({ error: { message: "You cannot review applications" } });
    const applications = await prisma.serverApplication.findMany({ where: { serverId: req.params.serverId }, include: { user: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } } }, orderBy: { createdAt: "desc" } });
    res.json({ applications });
  } catch (e) { next(e); }
});
featuresRouter.patch("/servers/:serverId/applications/:applicationId", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MANAGE_APPLICATIONS")) return res.status(403).json({ error: { message: "You cannot review applications" } });
    const body = z.object({ status: z.enum(["APPROVED", "REJECTED"]) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid application decision" } });
    const app = await prisma.serverApplication.findFirst({ where: { id: req.params.applicationId, serverId: req.params.serverId } });
    if (!app) return res.status(404).json({ error: { message: "Application not found" } });
    await prisma.$transaction(async tx => {
      await tx.serverApplication.update({ where: { id: app.id }, data: { status: body.data.status, reviewedById: req.auth!.userId, reviewedAt: new Date() } });
      if (body.data.status === "APPROVED") await tx.serverMember.upsert({ where: { serverId_userId: { serverId: req.params.serverId, userId: app.userId } }, create: { serverId: req.params.serverId, userId: app.userId }, update: {} });
    });
    await audit(req.params.serverId, req.auth!.userId, "APPLICATION_REVIEWED", app.id, { status: body.data.status });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Moderation and audit history
featuresRouter.get("/servers/:serverId/audit-log", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "VIEW_AUDIT_LOG")) return res.status(403).json({ error: { message: "You cannot view the audit log" } });
    const entries = await prisma.auditLog.findMany({ where: { serverId: req.params.serverId }, orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { username: true, displayName: true } } } });
    res.json({ entries });
  } catch (e) { next(e); }
});
featuresRouter.post("/servers/:serverId/moderation", async (req, res, next) => {
  try {
    if (!await can(req.params.serverId, req.auth!.userId, "MODERATE_MEMBERS")) return res.status(403).json({ error: { message: "You cannot moderate members" } });
    const body = z.object({ userId: id.optional(), username: z.string().trim().min(8).max(37).optional(), action: z.enum(["WARN", "KICK", "BAN", "UNBAN", "TIMEOUT"]), reason: z.string().max(500).optional(), expiresAt: z.string().datetime().optional() }).strict().refine(v => Boolean(v.userId || v.username)).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid moderation action" } });
    const targetUser = body.data.userId
      ? await prisma.user.findUnique({ where: { id: body.data.userId }, select: { id: true } })
      : await (async () => { const identity = /^([a-z0-9_]{3,32})#([0-9]{4})$/i.exec(body.data.username!); return identity ? prisma.user.findUnique({ where: { username_tag: { username: identity[1]!.toLowerCase(), tag: identity[2]! } }, select: { id: true } }) : null; })();
    if (!targetUser || targetUser.id === req.auth!.userId) return res.status(404).json({ error: { message: "Target user not found" } });
    const target = await memberOf(req.params.serverId, targetUser.id);
    if (target?.role === "OWNER") return res.status(403).json({ error: { message: "The server owner cannot be moderated" } });
    if (body.data.action !== "UNBAN" && !target) return res.status(404).json({ error: { message: "Member not found" } });
    if (body.data.action === "KICK" || body.data.action === "BAN") {
      if (target) await prisma.serverMember.delete({ where: { id: target.id } });
    }
    const record = await prisma.moderationRecord.create({ data: { serverId: req.params.serverId, actorId: req.auth!.userId, targetUserId: targetUser.id, action: body.data.action, reason: body.data.reason, expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : body.data.action === "TIMEOUT" ? new Date(Date.now() + 10 * 60 * 1000) : null } });
    await audit(req.params.serverId, req.auth!.userId, "MODERATION_" + body.data.action, targetUser.id, { reason: body.data.reason });
    res.status(201).json({ record });
  } catch (e) { next(e); }
});


// Reactions
featuresRouter.post("/channels/:channelId/messages/:messageId/reactions", async (req, res, next) => {
  try {
    const body = z.object({ emoji: z.string().trim().min(1).max(32) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Choose a valid reaction" } });
    const message = await prisma.message.findFirst({ where: { id: req.params.messageId, channelId: req.params.channelId }, include: { channel: { select: { serverId: true } } } });
    if (!message || !await memberOf(message.channel.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Message not found" } });
    const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId_emoji: { messageId: message.id, userId: req.auth!.userId, emoji: body.data.emoji } } });
    if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
    else await prisma.messageReaction.create({ data: { messageId: message.id, channelId: req.params.channelId, userId: req.auth!.userId, emoji: body.data.emoji } });
    const [reactions, updatedMessage] = await Promise.all([
      prisma.messageReaction.groupBy({ by: ["emoji"], where: { messageId: message.id }, _count: { _all: true } }),
      prisma.message.findUnique({
        where: { id: message.id },
        include: {
          author: { select: { id: true, username: true, tag: true, displayName: true, avatarUrl: true } },
          attachments: true,
          reactions: { select: { emoji: true, userId: true } }
        }
      })
    ]);
    if (updatedMessage) getRealtimeServer()?.to("channel:" + req.params.channelId).emit("message:update", updatedMessage);
    res.json({ reactions: reactions.map(item => ({ emoji: item.emoji, count: item._count._all })) });
  } catch (e) { next(e); }
});

// Supabase Storage signed uploads. Configure SUPABASE_SERVICE_ROLE_KEY and GUILDED_STORAGE_BUCKET on the backend only.
featuresRouter.post("/uploads/sign", async (req, res, next) => {
  try {
    const body = z.object({ fileName: z.string().trim().min(1).max(180), mimeType: z.string().min(1).max(120), size: z.number().int().positive().max(25 * 1024 * 1024), channelId: z.string().optional(), conversationId: z.string().optional() }).strict().refine(value => Boolean(value.channelId) !== Boolean(value.conversationId)).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { message: "Invalid upload details. Files must be 25 MB or smaller." } });
    const allowed = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm)|application\/pdf|text\/plain)$/;
    if (!allowed.test(body.data.mimeType)) return res.status(415).json({ error: { message: "This file type is not supported." } });
    if (body.data.channelId) {
      const channel = await prisma.channel.findUnique({ where: { id: body.data.channelId }, select: { serverId: true } });
      if (!channel || !await memberOf(channel.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Channel not found" } });
    }
    if (body.data.conversationId && !await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: body.data.conversationId, userId: req.auth!.userId } } })) {
      return res.status(404).json({ error: { message: "Conversation not found" } });
    }
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.GUILDED_STORAGE_BUCKET || "guilded-uploads";
    if (!url || !key) return res.status(503).json({ error: { message: "File uploads are not configured on this server yet." } });
    const storageKey = req.auth!.userId + "/" + crypto.randomUUID() + "-" + body.data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const signed = await fetch(url.replace(/\/$/, "") + "/storage/v1/object/upload/sign/" + encodeURIComponent(bucket) + "/" + storageKey.split("/").map(encodeURIComponent).join("/"), { method: "POST", headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ upsert: false }) });
    if (!signed.ok) return res.status(502).json({ error: { message: "Storage could not create an upload link." } });
    const payload = await signed.json() as { url?: string; signedURL?: string; token?: string };
    const signedPath = payload.url || payload.signedURL;
    if (!signedPath) return res.status(502).json({ error: { message: "Storage returned an invalid upload link." } });
    res.json({ storageKey, bucket, uploadUrl: signedPath.startsWith("http") ? signedPath : url.replace(/\/$/, "") + "/storage/v1" + signedPath, token: payload.token, fileName: body.data.fileName, mimeType: body.data.mimeType, size: body.data.size, channelId: body.data.channelId || null, conversationId: body.data.conversationId || null });
  } catch (e) { next(e); }
});
featuresRouter.post("/uploads/complete", async (req, res, next) => {
  try {
    const body = z.object({ storageKey: z.string().min(1).max(500), fileName: z.string().min(1).max(180), mimeType: z.string().min(1).max(120), size: z.number().int().positive().max(25 * 1024 * 1024), channelId: z.string().optional(), messageId: z.string().optional(), directMessageId: z.string().optional() }).strict().refine(value => !(value.messageId && value.directMessageId)).safeParse(req.body);
    if (!body.success || !body.data.storageKey.startsWith(req.auth!.userId + "/")) return res.status(400).json({ error: { message: "Invalid upload confirmation" } });
    if (body.data.channelId) {
      const channel = await prisma.channel.findUnique({ where: { id: body.data.channelId }, select: { serverId: true } });
      if (!channel || !await memberOf(channel.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Channel not found" } });
    }
    if (body.data.messageId && !await prisma.message.findFirst({ where: { id: body.data.messageId, authorId: req.auth!.userId, channelId: body.data.channelId } })) return res.status(404).json({ error: { message: "Message not found" } });
    if (body.data.directMessageId && !await prisma.directMessage.findFirst({ where: { id: body.data.directMessageId, authorId: req.auth!.userId, conversation: { members: { some: { userId: req.auth!.userId } } } } })) return res.status(404).json({ error: { message: "Direct message not found" } });
    if (body.data.directMessageId && body.data.channelId) return res.status(400).json({ error: { message: "Choose one attachment destination" } });
    const attachment = await prisma.attachment.create({ data: { storageKey: body.data.storageKey, fileName: body.data.fileName, mimeType: body.data.mimeType, size: body.data.size, uploaderId: req.auth!.userId, channelId: body.data.channelId, messageId: body.data.messageId, directMessageId: body.data.directMessageId } });
    res.status(201).json({ attachment });
  } catch (e) { next(e); }
});

featuresRouter.get("/uploads/:attachmentId/url", async (req, res, next) => {
  try {
    const attachment = await prisma.attachment.findUnique({ where: { id: req.params.attachmentId }, include: { channel: { select: { serverId: true } }, directMessage: { select: { conversationId: true } } } });
    if (!attachment) return res.status(404).json({ error: { message: "Attachment not found" } });
    if (attachment.channel && !await memberOf(attachment.channel.serverId, req.auth!.userId)) return res.status(404).json({ error: { message: "Attachment not found" } });
    if (attachment.directMessage && !await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: attachment.directMessage.conversationId, userId: req.auth!.userId } } })) return res.status(404).json({ error: { message: "Attachment not found" } });
    if (!attachment.channel && !attachment.directMessage && attachment.uploaderId !== req.auth!.userId) return res.status(404).json({ error: { message: "Attachment not found" } });
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.GUILDED_STORAGE_BUCKET || "guilded-uploads";
    if (!url || !key) return res.status(503).json({ error: { message: "File storage is not configured." } });
    const storageUrl = url.endsWith("/") ? url.slice(0, -1) : url;
    const path = attachment.storageKey.split("/").map(encodeURIComponent).join("/");
    const signed = await fetch(storageUrl + "/storage/v1/object/sign/" + encodeURIComponent(bucket) + "/" + path, { method: "POST", headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) });
    if (!signed.ok) return res.status(502).json({ error: { message: "Could not create a download link." } });
    const payload = await signed.json() as { signedURL?: string; signedUrl?: string };
    const signedPath = payload.signedURL || payload.signedUrl;
    if (!signedPath) return res.status(502).json({ error: { message: "Storage returned an invalid download link." } });
    res.json({ url: signedPath.startsWith("http") ? signedPath : storageUrl + "/storage/v1" + signedPath, fileName: attachment.fileName });
  } catch (e) { next(e); }
});
