import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "../../lib/crypto.js";
import { clearSessionCookie, SESSION_TTL_SECONDS, setSessionCookie } from "../../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
export const authRouter = Router();
const registerSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  displayName: z.string().trim().min(1).max(64).optional(),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128)
});
const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128)
});
function publicUser(user: { id: string; username: string; displayName: string | null; email: string; createdAt: Date }) {
  return { id: user.id, username: user.username, displayName: user.displayName, email: user.email, createdAt: user.createdAt.toISOString() };
}
async function issueSession(userId: string, response: Parameters<typeof setSessionCookie>[0]) {
  const token = createSessionToken();
  await prisma.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) }
  });
  setSessionCookie(response, token);
}
authRouter.post("/register", async (request, response, next) => {
  try {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Check the registration details", details: parsed.error.flatten().fieldErrors } });
      return;
    }
    const username = parsed.data.username.toLowerCase();
    const email = parsed.data.email.toLowerCase();
    const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } });
    if (existing) {
      response.status(409).json({ error: { code: "ACCOUNT_EXISTS", message: "That username or email is already in use" } });
      return;
    }
    const user = await prisma.user.create({
      data: { username, email, displayName: parsed.data.displayName ?? null, passwordHash: await hashPassword(parsed.data.password) },
      select: { id: true, username: true, displayName: true, email: true, createdAt: true }
    });
    await issueSession(user.id, response);
    response.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      response.status(409).json({ error: { code: "ACCOUNT_EXISTS", message: "That username or email is already in use" } });
      return;
    }
    next(error);
  }
});
authRouter.post("/login", async (request, response, next) => {
  try {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Enter your username/email and password" } });
      return;
    }
    const identifier = parsed.data.identifier.toLowerCase();
    const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier }, { username: identifier }] } });
    const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
    if (!user || !valid) {
      response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid username/email or password" } });
      return;
    }
    await issueSession(user.id, response);
    response.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});
authRouter.post("/logout", async (request, response, next) => {
  try {
    const token = request.cookies?.guilded_session;
    if (typeof token === "string") await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
    clearSessionCookie(response);
    response.status(204).end();
  } catch (error) { next(error); }
});
authRouter.get("/me", requireAuth, async (request, response, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: request.auth!.userId },
      select: { id: true, username: true, displayName: true, email: true, createdAt: true }
    });
    if (!user) {
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Account no longer exists" } });
      return;
    }
    response.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});
