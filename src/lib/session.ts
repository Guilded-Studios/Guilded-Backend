import type { Request, Response } from "express";
import { env } from "../config/env.js";
export const SESSION_COOKIE = "guilded_session";
export const SESSION_TTL_SECONDS = env.SESSION_TTL_DAYS * 24 * 60 * 60;
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: (env.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax",
  path: "/"
};
export function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 });
}
export function clearSessionCookie(response: Response): void { response.clearCookie(SESSION_COOKIE, cookieOptions); }
export function readSessionCookie(request: Request): string | undefined {
  const value = request.cookies?.[SESSION_COOKIE];
  return typeof value === "string" && value.length <= 256 ? value : undefined;
}
