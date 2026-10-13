import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000").refine(
    (value) => value.split(",").every((origin) => z.string().url().safeParse(origin.trim()).success),
    "FRONTEND_ORIGIN must contain comma-separated valid URLs",
  ),
  BACKEND_ORIGIN: z.string().url().default("http://localhost:4000"),
  COOKIE_DOMAIN: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string()
    .min(32, "SESSION_SECRET must contain at least 32 characters")
    .refine((value) => !value.startsWith("replace-"), "Replace the SESSION_SECRET placeholder with a random secret"),
  DATABASE_URL: z.string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => !value.includes("replace-with"), "Replace the DATABASE_URL password placeholder"),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
});

const parsed = environmentSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(
    `Invalid backend configuration:\n${details}\n\n` +
    "Create backend/.env from backend/.env.example, then set DATABASE_URL and " +
    "SESSION_SECRET (generate one with: openssl rand -base64 32). " +
    "See backend/README.md for the local database setup.",
  );
}

export const config = parsed.data;