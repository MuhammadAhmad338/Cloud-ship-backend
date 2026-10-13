import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./pool.js";

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsPath = join(process.cwd(), "migrations");
  const files = (await readdir(migrationsPath)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const existing = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (existing.rowCount) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(join(migrationsPath, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.info(`Applied migration ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

migrate()
  .catch((error: unknown) => {
    console.error("Database migration failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });