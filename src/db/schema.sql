-- Workers are the dev machines. They authenticate with a bearer token and are
-- only ever reachable outbound, so nothing here records an address.
CREATE TABLE IF NOT EXISTS workers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT,
  token_hash   TEXT NOT NULL,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);

-- A profile is one way to run an agent on one worker: which binary, which
-- model, whose account. credential_ref names a secret the runner resolves from
-- its own local config -- the server never stores credentials.
CREATE TABLE IF NOT EXISTS profiles (
  id             TEXT PRIMARY KEY,
  worker_id      TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  command        TEXT NOT NULL,
  -- launch_args go before our own flags, so a profile can be "node cli.js";
  -- args go after, for things like --model.
  launch_args_json TEXT NOT NULL DEFAULT '[]',
  args_json      TEXT NOT NULL DEFAULT '[]',
  env_json       TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (worker_id, label)
);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  worker_id          TEXT NOT NULL REFERENCES workers(id),
  path               TEXT NOT NULL,
  default_profile_id TEXT REFERENCES profiles(id),
  context            TEXT,
  -- How much this project's agents may do without asking. Enforced by Claude
  -- Code itself rather than by our shim: a tool that is allowed here never
  -- becomes a permission prompt, so it costs no round trip and there is no
  -- second matcher of ours to get subtly wrong.
  permission_mode    TEXT,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  denied_tools_json  TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  archived_at        TEXT
);

-- A session is one agent conversation. Its id is also passed to the agent as
-- its own session id, so --resume works without extra bookkeeping. run_count
-- distinguishes a fresh start from a resume.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  worker_id  TEXT NOT NULL REFERENCES workers(id),
  title      TEXT,
  state      TEXT NOT NULL CHECK (state IN
               ('queued','running','blocked','finished','failed','cancelled')),
  exit_code  INTEGER,
  run_count  INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  started_at TEXT,
  ended_at   TEXT,
  seen_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_worker_state ON sessions(worker_id, state);
CREATE INDEX IF NOT EXISTS idx_sessions_inbox ON sessions(seen_at, updated_at);

-- The message log is the whole history of a session. State is derived from the
-- agent process, never from reading these; they are the record, not the signal.
--   direction 'out' = agent -> operator, 'in' = operator -> agent
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL CHECK (direction IN ('out','in')),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('prompt','output','question','approval_request',
                  'answer','decision','result','error','note')),
  body         TEXT NOT NULL,
  payload_json TEXT,
  answered_by  INTEGER REFERENCES messages(id),
  delivered_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_undelivered
  ON messages(session_id, direction, delivered_at);
CREATE INDEX IF NOT EXISTS idx_messages_unanswered
  ON messages(direction, answered_by);

-- ---------------------------------------------------------------------------
-- OAuth, so the Claude mobile and desktop apps can connect.
--
-- They add a remote MCP server as a custom connector, and a custom connector
-- authenticates with OAuth, a static request header, or nothing. The static
-- header type is in beta for a limited set of organizations, and the MCP
-- authorization spec prohibits tokens in the URL -- so OAuth it is. There is
-- exactly one user here, so "signing in" is proving you know one password.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- An authorization that has been started but not yet proved. Everything the
-- flow depends on is kept here rather than in form fields, so a browser cannot
-- tamper with the redirect URI or the PKCE challenge between the two steps.
CREATE TABLE IF NOT EXISTS oauth_pending (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state          TEXT,
  scopes_json    TEXT NOT NULL DEFAULT '[]',
  resource       TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json    TEXT NOT NULL DEFAULT '[]',
  resource       TEXT,
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  created_at     TEXT NOT NULL
);

-- Tokens are stored as hashes, like worker tokens: the database never holds a
-- value that would let someone in.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  resource    TEXT,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id, kind);
