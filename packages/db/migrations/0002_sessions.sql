-- Login sessions. The cookie holds a random token; only its SHA-256 is stored,
-- so a database leak does not yield usable sessions.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  token_hash   bytea NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Sessions are looked up by token hash before any user is known, so they sit
-- outside RLS; the 256-bit token is the access control. Least privilege:
-- the app may create, touch and delete sessions but never rewrite their owner.
GRANT SELECT, INSERT, DELETE ON sessions TO riffle_app;
GRANT UPDATE (last_used_at, expires_at) ON sessions TO riffle_app;
