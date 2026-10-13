import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { HttpError } from "../middleware/errors.js";

const router = Router();

const createDeployment = z.object({
  projectId: z.string().uuid(),
  branch: z.string().trim().min(1).max(120).optional(),
  commitSha: z.string().trim().max(64).optional(),
  commitMessage: z.string().trim().max(500).default("Manual deployment"),
  environment: z.enum(["Production", "Staging", "Development", "Preview"]).optional(),
});

const deploymentStatusUpdate = z.object({
  status: z.enum(["Building", "Testing", "Deploying", "Live", "Failed"]),
  logLine: z.string().max(2_000).optional(),
});

const allowedTransitions: Record<string, string[]> = {
  Queued: ["Building", "Failed"],
  Building: ["Testing", "Failed"],
  Testing: ["Deploying", "Failed"],
  Deploying: ["Live", "Failed"],
};

router.get("/", async (request, response) => {
  const projectId = request.query.projectId
    ? z.string().uuid().parse(request.query.projectId)
    : undefined;
  const result = await pool.query(
    `SELECT d.id, d.project_id AS "projectId", p.name AS "projectName",
            d.branch, d.commit_sha AS "commitSha", d.commit_message AS "commitMessage",
            d.status, d.environment, d.author, d.logs, d.started_at AS "startedAt",
            d.finished_at AS "finishedAt", d.created_at AS "createdAt"
     FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE d.workspace_id = $1 AND ($2::uuid IS NULL OR d.project_id = $2)
     ORDER BY d.created_at DESC LIMIT 100`,
    [request.auth!.workspaceId, projectId ?? null],
  );
  response.json(result.rows);
});

router.post("/", async (request, response) => {
  const input = createDeployment.parse(request.body);
  const projectResult = await pool.query(
    `SELECT id, name, branch, environment FROM projects
     WHERE id = $1 AND workspace_id = $2`,
    [input.projectId, request.auth!.workspaceId],
  );
  const project = projectResult.rows[0] as { id: string; name: string; branch: string; environment: string } | undefined;
  if (!project) throw new HttpError(404, "Project not found.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO deployments
        (workspace_id, project_id, branch, commit_sha, commit_message, environment, author)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, project_id AS "projectId", branch, commit_sha AS "commitSha",
                 commit_message AS "commitMessage", status, environment, author,
                 created_at AS "createdAt"`,
      [request.auth!.workspaceId, project.id, input.branch ?? project.branch, input.commitSha ?? null,
       input.commitMessage, input.environment ?? project.environment, request.auth!.login],
    );
    const deployment = result.rows[0];
    await client.query(
      `INSERT INTO activity_events (workspace_id, project_id, deployment_id, actor, action, detail)
       VALUES ($1, $2, $3, $4, 'queued deployment', $5)`,
      [request.auth!.workspaceId, project.id, deployment.id, request.auth!.login, deployment.environment],
    );
    await client.query("COMMIT");
    response.status(202).json({ ...deployment, projectName: project.name });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.get("/:deploymentId", async (request, response) => {
  const deploymentId = z.string().uuid().parse(request.params.deploymentId);
  const result = await pool.query(
    `SELECT d.id, d.project_id AS "projectId", p.name AS "projectName",
            d.branch, d.commit_sha AS "commitSha", d.commit_message AS "commitMessage",
            d.status, d.environment, d.author, d.logs, d.started_at AS "startedAt",
            d.finished_at AS "finishedAt", d.created_at AS "createdAt"
     FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1 AND d.workspace_id = $2`,
    [deploymentId, request.auth!.workspaceId],
  );
  if (!result.rowCount) throw new HttpError(404, "Deployment not found.");
  response.json(result.rows[0]);
});

router.patch("/:deploymentId/status", async (request, response) => {
  const deploymentId = z.string().uuid().parse(request.params.deploymentId);
  const input = deploymentStatusUpdate.parse(request.body);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT id, project_id, status FROM deployments
       WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [deploymentId, request.auth!.workspaceId],
    );
    const current = currentResult.rows[0] as { id: string; project_id: string; status: string } | undefined;
    if (!current) throw new HttpError(404, "Deployment not found.");
    if (!allowedTransitions[current.status]?.includes(input.status)) {
      throw new HttpError(409, `Cannot move a deployment from ${current.status} to ${input.status}.`);
    }

    const result = await client.query(
      `UPDATE deployments
       SET status = $1,
           logs = CASE WHEN $2::text IS NULL THEN logs ELSE concat_ws(E'\\n', nullif(logs, ''), $2) END,
           started_at = CASE WHEN $1 = 'Building' THEN coalesce(started_at, now()) ELSE started_at END,
           finished_at = CASE WHEN $1 IN ('Live', 'Failed') THEN now() ELSE finished_at END
       WHERE id = $3 AND workspace_id = $4
       RETURNING id, project_id AS "projectId", status, logs,
                 started_at AS "startedAt", finished_at AS "finishedAt"`,
      [input.status, input.logLine ?? null, deploymentId, request.auth!.workspaceId],
    );

    if (input.status === "Live" || input.status === "Failed") {
      await client.query(
        "UPDATE projects SET status = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3",
        [input.status, current.project_id, request.auth!.workspaceId],
      );
    } else {
      await client.query(
        "UPDATE projects SET status = 'Building', updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [current.project_id, request.auth!.workspaceId],
      );
    }

    await client.query(
      `INSERT INTO activity_events (workspace_id, project_id, deployment_id, actor, action, detail)
       VALUES ($1, $2, $3, 'deployment worker', 'updated deployment', $4)`,
      [request.auth!.workspaceId, current.project_id, deploymentId, input.status],
    );
    await client.query("COMMIT");
    response.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export default router;