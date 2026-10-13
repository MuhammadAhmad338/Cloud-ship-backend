import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
});

pool.on("error", (error) => {
  console.error("Unexpected idle PostgreSQL client error", error);
});