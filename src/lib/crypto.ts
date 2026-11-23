import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)) as Buffer;
  return "scrypt:" + salt.toString("base64url") + ":" + derived.toString("base64url");
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = stored.split(":");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = (await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}
export function createSessionToken(): string { return randomBytes(32).toString("base64url"); }
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
