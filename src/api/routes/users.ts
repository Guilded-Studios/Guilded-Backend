import { randomInt, randomUUID } from "node:crypto";
import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
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

usersRouter.post("/me/media/sign", async (request, response, next) => {
  try {
    const parsed = z.object({
      kind: z.enum(["avatar", "banner"]),
      fileName: z.string().trim().min(1).max(180),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
      size: z.number().int().positive().max(10 * 1024 * 1024)
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "INVALID_MEDIA", message: "Choose a JPG, PNG, WEBP, or GIF image up to 10 MB." } });
      return;
    }
    const url = env.SUPABASE_URL.replace(/\/$/, "");
    // Support both the legacy service-role variable and Supabase's newer secret-key variable.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!key) {
      response.status(503).json({ error: { code: "STORAGE_NOT_CONFIGURED", message: "Profile image storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) to the backend environment." } });
      return;
    }
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as const)[parsed.data.mimeType];
    const storageKey = request.auth!.userId + "/" + parsed.data.kind + "/" + randomUUID() + "." + extension;
    const bucket = "guilded-profile-media";
    const encodedKey = storageKey.split("/").map(encodeURIComponent).join("/");
    const signed = await fetch(new URL("/storage/v1/object/upload/sign/" + bucket + "/" + encodedKey, url), {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ upsert: false })
    });
    if (!signed.ok) {
      const detail = await signed.text().catch(() => "");
      response.status(502).json({ error: { code: "STORAGE_SIGN_FAILED", message: "Storage could not create an upload link (" + signed.status + "). " + detail.slice(0, 300) } });
      return;
    }
    const payload = await signed.json() as { url?: string; signedURL?: string; signedUrl?: string; token?: string };
    const signedPath = payload.url || payload.signedURL || payload.signedUrl;
    if (!signedPath) {
      response.status(502).json({ error: { code: "STORAGE_INVALID_RESPONSE", message: "Storage returned an invalid upload link." } });
      return;
    }
    const uploadUrl = signedPath.startsWith("https://") || signedPath.startsWith("http://")
      ? signedPath
      : new URL(signedPath.startsWith("/storage/v1/") ? signedPath : "/storage/v1" + (signedPath.startsWith("/") ? signedPath : "/" + signedPath), url).toString();
    response.json({
      storageKey,
      uploadUrl,
      publicUrl: new URL("/storage/v1/object/public/" + bucket + "/" + encodedKey, url).toString(),
      mimeType: parsed.data.mimeType
    });
  } catch (error) { next(error); }
});

usersRouter.patch("/me", async (request, response, next) => {
  try {
    const parsed = z.object({
      username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/).optional(),
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
    const current = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: { username: true, tag: true } });
    if (!current) {
      response.status(404).json({ error: { code: "USER_NOT_FOUND", message: "Account not found" } });
      return;
    }
    const username = parsed.data.username?.toLowerCase();
    let tag = current.tag;
    if (username && username !== current.username) {
      const collision = await prisma.user.findUnique({ where: { username_tag: { username, tag } }, select: { id: true } });
      if (collision) {
        let allocated = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const candidate = String(randomInt(1000, 10000));
          const exists = await prisma.user.findUnique({ where: { username_tag: { username, tag: candidate } }, select: { id: true } });
          if (!exists) { tag = candidate; allocated = true; break; }
        }
        if (!allocated) {
          response.status(503).json({ error: { code: "TAG_ALLOCATION_FAILED", message: "Could not assign a new username tag. Please try again." } });
          return;
        }
      }
    }
    const profileData = { ...parsed.data };
    delete profileData.username;
    const user = await prisma.user.update({
      where: { id: request.auth!.userId },
      data: { ...profileData, ...(username ? { username, tag } : {}) },
      select: profileSelect
    });
    response.json({ user: { ...user, createdAt: user.createdAt.toISOString() } });
  } catch (error) { next(error); }
});

usersRouter.post("/me/credentials", async (request, response, next) => {
  try {
    const parsed = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128).optional(),
      newEmail: z.string().trim().email().max(254).optional()
    }).strict().safeParse(request.body);
    if (!parsed.success || (!parsed.data?.newPassword && !parsed.data?.newEmail)) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Enter your current password and a new email or password." } });
      return;
    }
    const account = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: { email: true } });
    if (!account) {
      response.status(404).json({ error: { code: "USER_NOT_FOUND", message: "Account not found" } });
      return;
    }
    const authResponse = await fetch(new URL("/auth/v1/token?grant_type=password", env.SUPABASE_URL), {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password: parsed.data.currentPassword })
    });
    const authData = await authResponse.json().catch(() => ({})) as { access_token?: string };
    if (!authResponse.ok || !authData.access_token) {
      response.status(401).json({ error: { code: "CURRENT_PASSWORD_INVALID", message: "Your current password is incorrect." } });
      return;
    }
    const attributes: Record<string, string> = {};
    if (parsed.data.newPassword) attributes.password = parsed.data.newPassword;
    if (parsed.data.newEmail) attributes.email = parsed.data.newEmail.toLowerCase();
    const updateResponse = await fetch(new URL("/auth/v1/user", env.SUPABASE_URL), {
      method: "PUT",
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + authData.access_token, "Content-Type": "application/json" },
      body: JSON.stringify(attributes)
    });
    const updateData = await updateResponse.json().catch(() => ({})) as { msg?: string; message?: string };
    if (!updateResponse.ok) {
      response.status(updateResponse.status === 422 ? 409 : 400).json({ error: { code: "CREDENTIAL_UPDATE_FAILED", message: updateData.msg ?? updateData.message ?? "Supabase could not update your account credentials." } });
      return;
    }
    if (parsed.data.newEmail) {
      response.json({ emailChangePending: true, message: "Check your new email address to confirm the change." });
      return;
    }
    response.json({ passwordUpdated: true });
  } catch (error) { next(error); }
});
