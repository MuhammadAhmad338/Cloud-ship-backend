import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

router.get("/", async (request, response) => {
  const result = await pool.query(
    `SELECT e.id, e.project_id AS "projectId", p.name AS "projectName",
            e.deployment_id AS "deploymentId", e.actor, e.action, e.detail,
            e.created_at AS "createdAt"
     FROM activity_events e
     LEFT JOIN projects p ON p.id = e.project_id
     WHERE e.workspace_id = $1
     ORDER BY e.created_at DESC LIMIT 100`,
    [request.auth!.workspaceId],
  );
  response.json(result.rows);
});

export default router;