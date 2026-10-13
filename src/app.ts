import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { requireSession } from "./auth/session.js";
import authRouter from "./routes/auth.js";
import activityRouter from "./routes/activity.js";
import deploymentsRouter from "./routes/deployments.js";
import environmentsRouter from "./routes/environments.js";
import projectsRouter from "./routes/projects.js";

export const app = express();

const allowedOrigins = new Set(config.FRONTEND_ORIGIN.split(",").map((origin) => origin.trim()));

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health/live", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/health/ready", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    const migrations = await pool.query<{ name: string }>(
      `SELECT name FROM schema_migrations
       WHERE name = ANY($1::text[])`,
      [["001_core.sql", "002_github_auth.sql"]],
    );
    const applied = new Set(migrations.rows.map((migration) => migration.name));
    const missing = ["001_core.sql", "002_github_auth.sql"].filter((name) => !applied.has(name));
    if (missing.length > 0) {
      response.status(503).json({
        status: "not_ready",
        error: "Database migrations are missing. Run `npm run db:migrate` from the backend directory.",
      });
      return;
    }
    response.json({ status: "ready", database: "connected", migrations: "current" });
  } catch (error) {
    console.error("Database readiness check failed", error);
    response.status(503).json({
      status: "not_ready",
      error: "Could not verify the database. Check DATABASE_URL, make sure PostgreSQL is running, and run `npm run db:migrate`.",
    });
  }
});

app.use("/auth", authRouter);

const apiRouter = express.Router();
apiRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
apiRouter.use("/auth", authRouter);
apiRouter.use(requireSession);
apiRouter.use("/github", authRouter);
apiRouter.use("/projects", projectsRouter);
apiRouter.use("/deployments", deploymentsRouter);
apiRouter.use("/environments", environmentsRouter);
apiRouter.use("/activity", activityRouter);
app.use("/api", apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);