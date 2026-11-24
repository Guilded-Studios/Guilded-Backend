import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
export const usersRouter: ExpressRouter = Router();
usersRouter.use(requireAuth);

const profileSelect = {
  id: true, username: true, tag: true, displayName: true, email: true,
  bio: true, pronouns: true, customStatus: true, avatarUrl: true,
  bannerUrl: true, profileVisibility: true, createdAt: true
} as const;

usersRouter.get("/me", async (request, response, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: profileSelect });
    if (!user) {
      response.status(404).json({ error: { code: "USER_NOT_FOUND", message: "Account not found" } });
      return;
    }
    response.json({ user: { ...user, createdAt: user.createdAt.toISOString() } });
  } catch (error) { next(error); }
});

usersRouter.patch("/me", async (request, response, next) => {
  try {
    const parsed = z.object({
      displayName: z.string().trim().min(1).max(64).nullable().optional(),
      bio: z.string().trim().max(190).nullable().optional(),
      pronouns: z.string().trim().max(40).nullable().optional(),
      customStatus: z.string().trim().max(80).nullable().optional(),
      avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
      bannerUrl: z.string().trim().url().max(2048).nullable().optional(),
      profileVisibility: z.enum(["EVERYONE", "FRIENDS", "NOBODY"]).optional()
    }).strict().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide valid profile settings", details: parsed.success ? undefined : parsed.error.flatten().fieldErrors } });
      return;
    }
    const user = await prisma.user.update({
      where: { id: request.auth!.userId },
      data: parsed.data,
      select: profileSelect
    });
    response.json({ user: { ...user, createdAt: user.createdAt.toISOString() } });
  } catch (error) { next(error); }
});
