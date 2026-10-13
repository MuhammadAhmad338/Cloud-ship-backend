CREATE TABLE github_users (
  github_id text PRIMARY KEY,
  login text NOT NULL,
  name text,
  email text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id text NOT NULL REFERENCES github_users(github_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  encrypted_access_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);
