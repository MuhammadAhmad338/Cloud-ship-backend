import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, RequestHandler } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

export type AuthenticatedUser = {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  workspaceId: string;
  sessionId: string;
  githubAccessToken: string;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthenticatedUser;
  }
}

export const SESSION_COOKIE = "cloudship_session";
export const OAUTH_STATE_COOKIE = "cloudship_oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const encryptionKey = createHash("sha256").update(config.SESSION_SECRET).digest();

export function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function serializeCookie(name: string, value: string, options: {
  maxAge: number;
  path?: string;
}): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (config.COOKIE_DOMAIN) attributes.push(`Domain=${config.COOKIE_DOMAIN}`);
  if (config.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function encryptAccessToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptAccessToken(value: string): string {
  const [encodedIv, encodedTag, encodedPayload] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedPayload) {
    throw new Error("Stored GitHub access token is malformed.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedPayload, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function secretsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function createSession(githubId: string, accessToken: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await pool.query(
    `INSERT INTO auth_sessions (github_id, token_hash, encrypted_access_token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [githubId, hashSessionToken(token), encryptAccessToken(accessToken), expiresAt],
  );
  return { token, expiresAt };
}

async function loadSession(request: Request): Promise<AuthenticatedUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const result = await pool.query(
    `SELECT s.id AS "sessionId", s.github_id AS id, s.encrypted_access_token AS "accessToken",
            u.login, u.name, u.email, u.avatar_url AS "avatarUrl"
     FROM auth_sessions s
     JOIN github_users u ON u.github_id = s.github_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = result.rows[0] as {
    sessionId: string;
    id: string;
    accessToken: string;
    login: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  } | undefined;
  if (!row) return null;

  return {
    id: row.id,
    login: row.login,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
    workspaceId: `github:${row.id}`,
    sessionId: row.sessionId,
    githubAccessToken: decryptAccessToken(row.accessToken),
  };
}

export const loadOptionalSession: RequestHandler = async (request, _response, next) => {
  try {
    request.auth = (await loadSession(request)) ?? undefined;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireSession: RequestHandler = async (request, response, next) => {
  if (request.auth) {
    next();
    return;
  }
  try {
    const user = await loadSession(request);
    if (!user) {
      response.status(401).json({ error: "Sign in with GitHub to continue." });
      return;
    }
    request.auth = user;
    next();
  } catch (error) {
    next(error);
  }
};

export const SESSION_MAX_AGE = SESSION_MAX_AGE_SECONDS;
