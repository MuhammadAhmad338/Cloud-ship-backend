CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  name text NOT NULL,
  repository text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  framework text NOT NULL CHECK (framework IN ('Next.js', 'Node.js', 'React', 'Flutter Web')),
  environment text NOT NULL CHECK (environment IN ('Production', 'Staging', 'Development', 'Preview')),
  status text NOT NULL DEFAULT 'Ready' CHECK (status IN ('Ready', 'Building', 'Live', 'Failed')),
  build_command text NOT NULL DEFAULT 'npm run build',
  start_command text NOT NULL DEFAULT 'npm start',
  root_directory text NOT NULL DEFAULT '/',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, repository, branch, environment)
);

CREATE INDEX projects_workspace_updated_idx ON projects (workspace_id, updated_at DESC);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch text NOT NULL,
  commit_sha text,
  commit_message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Building', 'Testing', 'Deploying', 'Live', 'Failed')),
  environment text NOT NULL CHECK (environment IN ('Production', 'Staging', 'Development', 'Preview')),
  author text NOT NULL DEFAULT 'Unknown',
  logs text NOT NULL DEFAULT '',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployments_workspace_created_idx ON deployments (workspace_id, created_at DESC);
CREATE INDEX deployments_project_created_idx ON deployments (project_id, created_at DESC);

CREATE TABLE activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_workspace_created_idx ON activity_events (workspace_id, created_at DESC);