# CloudShip API

Express and PostgreSQL backend for the CloudShip Next.js frontend. GitHub OAuth authorization, callback handling, encrypted provider tokens, and user sessions are owned by this API; the browser never receives a GitHub access token.

## GitHub OAuth setup

1. Revoke any GitHub OAuth client secret that has been shared in chat, logs, or source control, then generate a replacement in GitHub **Settings → Developer settings → OAuth Apps**.
2. Set the OAuth app homepage to `http://localhost:3000` and its callback URL to `http://localhost:4000/auth/github/callback`.
3. Copy `.env.example` to `.env` in this directory. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a unique `SESSION_SECRET` of at least 32 characters. Generate the session secret with `openssl rand -base64 32`; replace the placeholder rather than using it as a secret.
4. Configure the frontend's server-side `CLOUDSHIP_API_URL=http://localhost:4000` in the repository root `.env.local`.
5. Start PostgreSQL and apply migrations before running the API.

The OAuth request asks for `read:user user:email repo` so CloudShip can identify the account and list authorized repositories, including private repositories. Review these permissions before authorizing.

For local development, the frontend and API should use the same hostname (`localhost`) so the HTTP-only session cookie is shared across ports. In production, use HTTPS and either a shared parent cookie domain (`COOKIE_DOMAIN=.example.com`) for frontend/API subdomains, or serve them under a common site. Do not configure a broad cookie domain unless all matching subdomains are trusted.

## Local setup

Use Node.js 22 or newer and a locally installed PostgreSQL server; Docker is not used. On macOS with Homebrew, start the installed PostgreSQL service (for example, `brew services start postgresql@18`). From the `backend/` directory, run the development command once to generate `backend/.env` with private, random local database and session secrets:

```sh
npm run dev
```

The generated `.env` is private to your machine and ignored by Git. With PostgreSQL running, from `backend/`, create/configure the local `cloudship` role and database, then apply migrations:

```sh
npm run db:setup-local
npm run db:migrate
```

`db:setup-local` is restricted to `localhost`, the `cloudship` database, and the `cloudship` role. It preserves existing database contents, grants the role access, and uses the current macOS account's local PostgreSQL administrator permissions. It does not use Docker or modify remote databases. Add your replacement GitHub OAuth App credentials to `backend/.env` when ready to test sign-in. The backend requires `DATABASE_URL` and `SESSION_SECRET` at startup.

The liveness endpoint is `GET /health/live`; `GET /health/ready` verifies PostgreSQL connectivity and confirms the core and GitHub-auth migrations have been applied. It returns `503` with setup guidance when the database is unreachable or migrations are missing.

## Authentication endpoints

- `GET /auth/github` starts OAuth authorization and sets a short-lived, HTTP-only state cookie.
- `GET /auth/github/callback` validates state, exchanges the code server-side, loads the GitHub profile, creates the session, and sends the user to the frontend repository-import screen.
- `GET /api/auth/session` returns the signed-in user's public profile.
- `POST /api/auth/logout` revokes the current session.
- `GET /api/github/repositories` lists repositories for the signed-in user.

The API stores only a hash of each random session cookie and encrypts GitHub access tokens at rest using `SESSION_SECRET`. OAuth secrets, session secrets, and database credentials must remain in environment files and must never be committed.

## Workspace API

All `/api/projects`, `/api/deployments`, `/api/environments`, and `/api/activity` routes require the HTTP-only backend session and are scoped to the authenticated GitHub account. Project and deployment SQL statements are parameterized. Deployment creation records a queued deployment; the status endpoint enforces lifecycle transitions. A separate isolated build worker is still required before deployments can execute source code or publish an app.

## Azure services

For a hosted API, use **Azure App Service** (Linux, Node.js runtime) and **Azure Database for PostgreSQL Flexible Server**. Review current pricing and configure a Cost Management budget and alert before creating paid resources; an alert does not cap spending.
