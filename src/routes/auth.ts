import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  createSession,
  loadOptionalSession,
  OAUTH_STATE_COOKIE,
  readCookie,
  requireSession,
  secretsMatch,
  serializeCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "../auth/session.js";
import { HttpError } from "../middleware/errors.js";

const router = Router();
const frontendUrl = config.FRONTEND_ORIGIN.split(",")[0]!.trim();
const callbackUrl = new URL("/auth/github/callback", config.BACKEND_ORIGIN).toString();
const githubOAuthConfigured = Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);

const githubTokenResponse = z.object({ access_token: z.string().min(1) });
const githubUserResponse = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
});
const githubEmailResponse = z.array(z.object({
  email: z.string().email(),
  primary: z.boolean(),
  verified: z.boolean(),
}));

router.get("/github", (_request, response) => {
  if (!githubOAuthConfigured) {
    response.status(503).json({ error: "GitHub OAuth is not configured on the server." });
    return;
  }

  const state = randomBytes(32).toString("hex");
  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", config.GITHUB_CLIENT_ID!);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizationUrl.searchParams.set("scope", "read:user user:email repo");
  authorizationUrl.searchParams.set("state", state);
  response.append(
    "Set-Cookie",
    serializeCookie(OAUTH_STATE_COOKIE, state, { maxAge: 600, path: "/auth/github" }),
  );
  response.redirect(302, authorizationUrl.toString());
});

router.get("/github/callback", async (request, response) => {
  const clearStateCookie = serializeCookie(OAUTH_STATE_COOKIE, "", { maxAge: 0, path: "/auth/github" });
  const fail = (error: string) => {
    response.append("Set-Cookie", clearStateCookie);
    response.redirect(302, `${frontendUrl}/login?error=${encodeURIComponent(error)}`);
  };

  if (!githubOAuthConfigured) {
    fail("OAuthConfiguration");
    return;
  }
  if (request.query.error) {
    fail(request.query.error === "access_denied" ? "AccessDenied" : "OAuthError");
    return;
  }

  const state = z.string().min(1).safeParse(request.query.state);
  const code = z.string().min(1).safeParse(request.query.code);
  const stateCookie = readCookie(request, OAUTH_STATE_COOKIE);
  if (!state.success || !code.success || !secretsMatch(state.data, stateCookie)) {
    fail("InvalidOAuthState");
    return;
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code: code.data,
      redirect_uri: callbackUrl,
      state: state.data,
    }),
  });
  if (!tokenResponse.ok) {
    fail("TokenExchange");
    return;
  }
  const token = githubTokenResponse.safeParse(await tokenResponse.json());
  if (!token.success) {
    fail("TokenExchange");
    return;
  }

  const githubHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token.data.access_token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubHeaders,
  });
  if (!userResponse.ok) {
    fail("ProfileLookup");
    return;
  }
  const githubUser = githubUserResponse.safeParse(await userResponse.json());
  if (!githubUser.success) {
    fail("ProfileLookup");
    return;
  }

  let email = githubUser.data.email ?? null;
  if (!email) {
    const emailResponse = await fetch("https://api.github.com/user/emails", {
      headers: githubHeaders,
    });
    if (emailResponse.ok) {
      const emails = githubEmailResponse.safeParse(await emailResponse.json());
      if (emails.success) {
        email = emails.data.find((entry) => entry.primary && entry.verified)?.email ?? null;
      }
    }
  }

  const githubId = String(githubUser.data.id);
  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    await pool.query(
      `INSERT INTO github_users (github_id, login, name, email, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_id) DO UPDATE SET
         login = EXCLUDED.login,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         avatar_url = EXCLUDED.avatar_url,
         updated_at = now()`,
      [githubId, githubUser.data.login, githubUser.data.name ?? null, email, githubUser.data.avatar_url ?? null],
    );
    session = await createSession(githubId, token.data.access_token);
  } catch (error) {
    const databaseCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    console.error("GitHub OAuth could not persist the user session", { databaseCode });
    fail("DatabaseUnavailable");
    return;
  }

  response.append("Set-Cookie", clearStateCookie);
  response.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, session.token, { maxAge: SESSION_MAX_AGE }),
  );
  response.redirect(302, `${frontendUrl}/projects/new`);
});

router.get("/session", loadOptionalSession, (request, response) => {
  if (!request.auth) {
    response.status(401).json({ error: "Not signed in." });
    return;
  }
  const { githubAccessToken: _token, sessionId: _sessionId, workspaceId: _workspaceId, ...user } = request.auth;
  response.json({ user });
});

router.post("/logout", requireSession, async (request, response) => {
  await pool.query("DELETE FROM auth_sessions WHERE id = $1", [request.auth!.sessionId]);
  const expiredCookie = serializeCookie(SESSION_COOKIE, "", { maxAge: 0 });
  response.append("Set-Cookie", expiredCookie);
  response.status(204).end();
});

router.get("/repositories", requireSession, async (request, response) => {
  const upstream = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=updated&type=all",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.auth!.githubAccessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!upstream.ok) {
    throw new HttpError(502, "GitHub could not list repositories.");
  }
  const repositories = z.array(z.object({
    id: z.number().int(),
    full_name: z.string(),
    default_branch: z.string(),
    private: z.boolean(),
    html_url: z.string().url(),
  })).parse(await upstream.json());
  response.json(repositories.map((repository) => ({
    id: repository.id,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private,
    url: repository.html_url,
  })));
});

export default router;
