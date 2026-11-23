import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { hashSessionToken } from "../../lib/crypto.js";
import { readSessionCookie } from "../../lib/session.js";
declare global {
  namespace Express {
    interface Request { auth?: { userId: string; sessionId: string } }
  }
}
export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  try {
    const token = readSessionCookie(request);
    if (!token) {
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue" } });
      return;
    }
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      select: { id: true, userId: true, expiresAt: true }
    });
    if (!session || session.expiresAt <= new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Your session has expired" } });
      return;
    }
    request.auth = { userId: session.userId, sessionId: session.id };
    next();
  } catch (error) { next(error); }
}
