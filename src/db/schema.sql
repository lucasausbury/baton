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
