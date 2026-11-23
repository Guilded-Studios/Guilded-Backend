import "dotenv/config";
import { z } from "zod";
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_ORIGINS: z.string().default("http://localhost:5173"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  DATABASE_URL: z.string().url()
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
export const allowedOrigins = env.CLIENT_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
