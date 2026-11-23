import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { createSessionToken, hashSessionToken } from "../../lib/crypto.js";
import { clearSessionCookie, SESSION_TTL_SECONDS, setSessionCookie } from "../../lib/session.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter: ExpressRouter = Router();

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

type SupabaseUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};
type SupabaseAuthResponse = { user?: SupabaseUser | null; session?: unknown; msg?: string; message?: string };

function publicUser(user: { id: string; username: string; displayName: string | null; email: string; createdAt: Date }) {
  return { id: user.id, username: user.username, displayName: user.displayName, email: user.email, createdAt: user.createdAt.toISOString() };
}

async function supabaseAuth(path: string, body: Record<string, unknown>): Promise<{ response: globalThis.Response; data: SupabaseAuthResponse }> {
  const response = await fetch(new URL(`/auth/v1/${path}`, env.SUPABASE_URL), {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({})) as SupabaseAuthResponse;
  return { response, data };
}

function metadataString(user: SupabaseUser, key: string): string | undefined {
  const value = user.user_metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function uniqueUsername(preferred: string, supabaseId: string): Promise<string> {
  const normalized = preferred.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  const base = normalized.length >= 3 ? normalized : `member_${supabaseId.slice(0, 8)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? "" : `_${attempt + 1}`;
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    const existing = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new Error("Unable to allocate a unique Guilded username");
}

async function ensureGuildedUser(authUser: SupabaseUser, requested?: { username?: string; displayName?: string }): Promise<{
  id: string; username: string; displayName: string | null; email: string; createdAt: Date;
}> {
  const email = authUser.email?.toLowerCase();
  if (!email) throw new Error("Supabase did not return an email address");

  const linked = await prisma.user.findUnique({ where: { supabaseId: authUser.id } });
  if (linked) {
    if (linked.email !== email) {
      return prisma.user.update({
        where: { id: linked.id },
        data: { email },
        select: { id: true, username: true, displayName: true, email: true, createdAt: true }
      });
    }
    return linked;
  }

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    return prisma.user.update({
      where: { id: byEmail.id },
      data: { supabaseId: authUser.id, passwordHash: null },
      select: { id: true, username: true, displayName: true, email: true, createdAt: true }
    });
  }

  const preferredUsername = requested?.username
    ?? metadataString(authUser, "username")
    ?? email.split("@")[0]
    ?? "member";
  const displayName = requested?.displayName ?? metadataString(authUser, "display_name") ?? null;
  const username = await uniqueUsername(preferredUsername, authUser.id);
  return prisma.user.create({
    data: { username, email, displayName, supabaseId: authUser.id, passwordHash: null },
    select: { id: true, username: true, displayName: true, email: true, createdAt: true }
  });
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

    const { response: authResponse, data } = await supabaseAuth("signup", {
      email,
      password: parsed.data.password,
      data: { username, display_name: parsed.data.displayName ?? username }
    });
    if (!authResponse.ok || !data.user) {
      const detail = (data.msg ?? data.message ?? "").toLowerCase();
      if (authResponse.status === 409 || authResponse.status === 422 || detail.includes("already registered") || detail.includes("already exists")) {
        response.status(409).json({ error: { code: "ACCOUNT_EXISTS", message: "An account with that email already exists. Try signing in instead." } });
        return;
      }
      response.status(400).json({ error: { code: "SUPABASE_SIGNUP_FAILED", message: "Supabase could not create the account. Check the details and try again." } });
      return;
    }

    const user = await ensureGuildedUser(data.user, { username, displayName: parsed.data.displayName });
    if (!data.session) {
      response.status(201).json({ user: publicUser(user), confirmationRequired: true });
      return;
    }
    await issueSession(user.id, response);
    response.status(201).json({ user: publicUser(user), confirmationRequired: false });
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
    const localUser = identifier.includes("@")
      ? null
      : await prisma.user.findUnique({ where: { username: identifier } });
    const email = localUser?.email ?? identifier;
    const { response: authResponse, data } = await supabaseAuth("token?grant_type=password", {
      email,
      password: parsed.data.password
    });
    if (!authResponse.ok || !data.user) {
      if (authResponse.status === 400 || authResponse.status === 401) {
        response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid username/email or password. If you just signed up, confirm your email first." } });
        return;
      }
      response.status(503).json({ error: { code: "AUTH_UNAVAILABLE", message: "Supabase authentication is temporarily unavailable. Please try again." } });
      return;
    }

    const user = await ensureGuildedUser(data.user);
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
