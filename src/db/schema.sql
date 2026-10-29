-- Workers are the dev machines. They authenticate with a bearer token and are
-- only ever reachable outbound, so nothing here records an address.
-- inventory_json is what the worker last reported about itself: its project
-- paths, its profile labels, the posture each project allows. It is shown in
-- the Claude apps and never used to launch anything, because the machine is
-- the authority on all of it.
CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT,
  token_hash    TEXT NOT NULL,
  last_seen_at  TEXT,
  inventory_json TEXT,
  inventory_at  TEXT,
  created_at    TEXT NOT NULL
);

-- A profile is a label for an account on one worker, and nothing else.
--
-- What it runs -- the binary, its arguments, its environment, which credential
-- it uses -- is in that machine's runner.config.json, keyed by slug(label).
-- None of it is here on purpose: a server that could name an executable and
-- its environment could run anything it liked on every machine enrolled with
-- it, and the login password would be the only thing in the way.
CREATE TABLE IF NOT EXISTS profiles (
  id             TEXT PRIMARY KEY,
  worker_id      TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (worker_id, label)
);

-- A project is a name, a machine, and how much you are asking its agents to
-- be trusted with. The checkout's path is in the worker's own config, so the
-- server cannot repoint a project at someone's home directory and then queue
-- "summarise the files here".
--
-- requested_posture is a request, not a grant: the worker holds the ceiling and
-- takes the stricter of the two. It is one of the names in POSTURES rather than
-- a list of tool patterns, so there is nothing here to inject.
CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  worker_id          TEXT NOT NULL REFERENCES workers(id),
  default_profile_id TEXT REFERENCES profiles(id),
  context            TEXT,
  requested_posture  TEXT,
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
