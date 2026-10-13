import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
const databasePassword = randomBytes(24).toString("base64url");
const sessionSecret = randomBytes(48).toString("base64url");
const contents = [
  "NODE_ENV=development",
  "PORT=4000",
  "FRONTEND_ORIGIN=http://localhost:3000",
  "BACKEND_ORIGIN=http://localhost:4000",
  `POSTGRES_PASSWORD=${databasePassword}`,
  `DATABASE_URL=postgresql://cloudship:${databasePassword}@localhost:5432/cloudship`,
  "GITHUB_CLIENT_ID=",
  "GITHUB_CLIENT_SECRET=",
  `SESSION_SECRET=${sessionSecret}`,
  "PG_POOL_MAX=5",
  "",
].join("\n");

try {
  const file = await open(envPath, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
  } finally {
    await file.close();
  }
  console.info("Created backend/.env with local development secrets.");
  console.info("Start your local PostgreSQL service, then run `npm run db:setup-local` and `npm run db:migrate`.");
  console.info("Add your replacement GitHub OAuth credentials to backend/.env when ready to sign in.");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
    console.info("Using existing backend/.env.");
  } else {
    throw error;
  }
}
