import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Run `npm run dev` once to create backend/.env.");
}

const url = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
  url.pathname !== "/cloudship" ||
  decodeURIComponent(url.username) !== "cloudship"
) {
  throw new Error(
    "Local database setup only supports cloudship@localhost/cloudship. " +
    "It will not modify a remote or differently named database.",
  );
}

const password = decodeURIComponent(url.password);
if (!/^[A-Za-z0-9_-]{24,}$/.test(password)) {
  throw new Error(
    "The local database password must be generated base64url text. " +
    "Regenerate backend/.env only if it does not contain data or credentials you need.",
  );
}

const { Client } = pg;
const admin = new Client({ database: "postgres", host: "/tmp" });
await admin.connect();

try {
  const roleResult = await admin.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'cloudship'",
  );
  if (roleResult.rowCount) {
    await admin.query(`ALTER ROLE cloudship WITH LOGIN PASSWORD '${password}'`);
    console.info("Updated the local cloudship PostgreSQL role password.");
  } else {
    await admin.query(`CREATE ROLE cloudship LOGIN PASSWORD '${password}'`);
    console.info("Created the local cloudship PostgreSQL role.");
  }

  const databaseResult = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = 'cloudship'",
  );
  if (databaseResult.rowCount) {
    await admin.query("ALTER DATABASE cloudship OWNER TO cloudship");
    console.info("Using the existing cloudship database; its contents are preserved.");
  } else {
    await admin.query("CREATE DATABASE cloudship OWNER cloudship");
    console.info("Created the local cloudship database.");
  }
} finally {
  await admin.end();
}

const localAdmin = new Client({ database: "cloudship", host: "/tmp" });
await localAdmin.connect();
try {
  await localAdmin.query("GRANT ALL ON SCHEMA public TO cloudship");
  await localAdmin.query("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cloudship");
  await localAdmin.query("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO cloudship");
  console.info("Granted cloudship access to the existing application schema and data.");
} finally {
  await localAdmin.end();
}
