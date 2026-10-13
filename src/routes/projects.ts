import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { HttpError } from "../middleware/errors.js";

const router = Router();

const projectInput = z.object({
  name: z.string().trim().min(1).max(80),
  repository: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/),
  branch: z.string().trim().min(1).max(120).default("main"),
  framework: z.enum(["Next.js", "Node.js", "React", "Flutter Web"]),
  environment: z.enum(["Production", "Staging", "Development", "Preview"]).default("Production"),
  buildCommand: z.string().trim().max(200).default("npm run build"),
  startCommand: z.string().trim().max(200).default("npm start"),
  rootDirectory: z.string().trim().max(200).default("/"),
});

const projectUpdate = projectInput.partial().refine((value) => Object.keys(value).length > 0, {
  message: "Provide at least one field to update",
});

const projectColumns = {
  name: "name",
  repository: "repository",
  branch: "branch",
  framework: "framework",
  environment: "environment",
  buildCommand: "build_command",
  startCommand: "start_command",
  rootDirectory: "root_directory",
} as const;

router.get("/", async (request, response) => {
  const result = await pool.query(
    `SELECT id, name, repository, branch, framework, environment, status,
            build_command AS "buildCommand", start_command AS "startCommand",
            root_directory AS "rootDirectory", created_at AS "createdAt",
            updated_at AS "updatedAt"
     FROM projects WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 100`,
    [request.auth!.workspaceId],
  );
  response.json(result.rows);
});

router.post("/", async (request, response) => {
  const input = projectInput.parse(request.body);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO projects
        (workspace_id, name, repository, branch, framework, environment,
         build_command, start_command, root_directory)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, repository, branch, framework, environment, status,
                 build_command AS "buildCommand", start_command AS "startCommand",
                 root_directory AS "rootDirectory", created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [request.auth!.workspaceId, input.name, input.repository, input.branch, input.framework,
        input.environment, input.buildCommand, input.startCommand, input.rootDirectory],
    );
    const project = result.rows[0];
    await client.query(
      `INSERT INTO activity_events (workspace_id, project_id, actor, action, detail)
       VALUES ($1, $2, $3, 'created project', $4)`,
      [request.auth!.workspaceId, project.id, request.auth!.login, input.repository],
    );
    await client.query("COMMIT");
    response.status(201).json(project);
  } catch (error) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "A project already exists for this repository, branch, and environment.");
    }
    throw error;
  } finally {
    client.release();
  }
});

router.get("/:projectId", async (request, response) => {
  const projectId = z.string().uuid().parse(request.params.projectId);
  const result = await pool.query(
    `SELECT id, name, repository, branch, framework, environment, status,
            build_command AS "buildCommand", start_command AS "startCommand",
            root_directory AS "rootDirectory", created_at AS "createdAt",
            updated_at AS "updatedAt"
     FROM projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, request.auth!.workspaceId],
  );
  if (!result.rowCount) throw new HttpError(404, "Project not found.");
  response.json(result.rows[0]);
});

router.patch("/:projectId", async (request, response) => {
  const projectId = z.string().uuid().parse(request.params.projectId);
  const input = projectUpdate.parse(request.body);
  const values: unknown[] = [projectId, request.auth!.workspaceId];
  const assignments: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    const column = projectColumns[key as keyof typeof projectColumns];
    if (!column) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  const result = await pool.query(
    `UPDATE projects SET ${assignments.join(", ")}, updated_at = now()
     WHERE id = $1 AND workspace_id = $2
     RETURNING id, name, repository, branch, framework, environment, status,
               build_command AS "buildCommand", start_command AS "startCommand",
               root_directory AS "rootDirectory", created_at AS "createdAt",
               updated_at AS "updatedAt"`,
    values,
  );
  if (!result.rowCount) throw new HttpError(404, "Project not found.");
  response.json(result.rows[0]);
});

router.delete("/:projectId", async (request, response) => {
  const projectId = z.string().uuid().parse(request.params.projectId);
  const result = await pool.query(
    "DELETE FROM projects WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [projectId, request.auth!.workspaceId],
  );
  if (!result.rowCount) throw new HttpError(404, "Project not found.");
  response.status(204).end();
});

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export default router;