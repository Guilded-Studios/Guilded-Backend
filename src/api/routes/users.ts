import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
export const usersRouter = Router();
usersRouter.use(requireAuth);
usersRouter.patch("/me", async (request, response, next) => {
  try {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(64).nullable().optional() }).strict().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide a valid displayName update" } });
      return;
    }
    const user = await prisma.user.update({
      where: { id: request.auth!.userId },
      data: { displayName: parsed.data.displayName },
      select: { id: true, username: true, displayName: true, email: true, createdAt: true }
    });
    response.json({ user: { ...user, createdAt: user.createdAt.toISOString() } });
  } catch (error) { next(error); }
});
