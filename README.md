# ai-worker-manager

Central queue and control plane for AI coding agents running on remote dev
machines. Managed from the Claude desktop and mobile apps over MCP — there is no
web UI, by design.

## Why it is shaped this way

**A task is a conversation, not a job.** Mid-task interactivity is a first-class
requirement, so there is one primitive — a *session* with a message log — rather
than a job queue plus a side channel for questions. "Go do this" is the first
message in; "I need approval for X" is a message out; "yes, go ahead" is a
message in.

**State comes from the agent process, never from message content.** A session is
`running`, `blocked`, `finished`, `failed`, `queued` or `cancelled`. `blocked`
is set only by an explicit ask, because you cannot tell "waiting on stdin" from
"thinking hard for four minutes" by inspecting a process. A final "all done"
message is just output and blocks nothing.

**The agent calls out; the runner does not mediate.** `claude -p` runs deny
approvals by default, and the supported escape is a permission host named with
`--permission-prompt-tool`. So permission requests and clarifying questions
travel from the agent to this server over MCP, and the runner only has to spawn
the process, stream its output, and report the exit code. No stdin scraping, no
agent-to-agent messenger.

**Workers only ever talk outbound.** They roam between networks and have no
stable address, so everything is long-polling: the runner holds a request open
and the server answers the moment work appears. That gives push latency with no
listener on the worker, and a laptop resumes from any network with no config.

**The operator's inbox is separate from the worker's lifecycle.** Nothing on a
worker ever waits for an acknowledgement — the process exits, the runner reaps
it, done. `seen_at` exists purely so *you* can tell which finished sessions you
have not read.

**No credentials in the database.** A profile carries non-secret env (such as
`CLAUDE_CONFIG_DIR`) plus a `credential_ref` that the runner resolves from its
own local config.

## Running it

Needs Node 24+ (uses built-in `node:sqlite` and runs TypeScript directly, so
there is no build step and no native dependency).

```bash
npm install
AWM_ADMIN_TOKEN=$(openssl rand -hex 24) npm run server
```

Then register a machine and a project:

```bash
npm run cli -- worker add "MacBook Pro" --platform darwin
npm run cli -- profile add --worker macbook-pro --label opus-personal \
  --command claude --args "--model opus" --env CLAUDE_CONFIG_DIR=~/.claude-personal
npm run cli -- project add --name alexandria --worker macbook-pro \
  --path /Users/lucas/src/alexandria --profile macbook-pro:opus-personal
```

The worker token is printed once and is not recoverable.

### Configuration

| Variable | Default | Purpose |
| - | - | - |
| `AWM_DB` | `data/awm.db` | SQLite file; the whole system's state |
| `AWM_PORT` / `AWM_HOST` | `8787` / `0.0.0.0` | Listen address |
| `AWM_ADMIN_TOKEN` | — | Bearer token for `/mcp`; required unless bound to loopback |
| `AWM_NTFY_TOPIC` | — | ntfy topic for push; without it notifications are logged only |
| `AWM_NTFY_URL` | `https://ntfy.sh` | Point at a self-hosted ntfy |
| `AWM_PUBLIC_URL` | — | Used to attach a click-through URL to pushes |
| `AWM_APPROVAL_WAIT_MS` | 6h | How long an approval request may stay parked |
| `AWM_BLOCKED_REMINDER_MS` | 20m | Re-notify about a session still blocked |

## Interfaces

### MCP, at `/mcp` (admin bearer token)

`list_workers`, `list_projects`, `register_project`, `create_session`,
`list_sessions`, `get_session`, `reply`, `resume_session`, `cancel_session`,
`acknowledge`.

There is deliberately no draft-and-approve step: you are already in a Claude
conversation when you create a task, so the planning happens there and calling
`create_session` *is* the sign-off.

### Runner REST, at `/v1` (worker bearer token)

| Route | Purpose |
| - | - |
| `GET /v1/work?wait=ms` | Long-poll; claims and returns work for this worker |
| `POST /v1/sessions/:id/started` | Process is up |
| `POST /v1/sessions/:id/output` | Append output (`kind`: `output`/`result`/`error`) |
| `POST /v1/sessions/:id/ask` | Ask the operator; **held open until answered** |
| `GET /v1/sessions/:id/ask` | Re-attach to an ask whose request was cut off |
| `GET /v1/sessions/:id/inbound` | Undelivered operator messages, for stdin |
| `POST /v1/sessions/:id/exit` | Report the exit code |

A worker can only ever see or touch its own sessions. Every authenticated
request counts as a heartbeat.

## Tests

```bash
npm run smoke   # store and state machine, in-process
npm run api     # the server over real HTTP, including a real MCP client
npm run typecheck
```

## Not built yet

- **The runner.** Polls `/v1/work`, spawns the agent with the profile's env,
  streams output back, reports the exit code.
- **The permission shim.** A tiny stdio MCP server the runner spawns and names
  with `--permission-prompt-tool`, which relays approvals to `/v1/.../ask`. It
  is local rather than pointed at this server directly so that session startup
  does not wait on café wifi, and so the worker token stays on the worker.
- **One open question.** How long Claude Code will wait for the permission tool
  to answer is undocumented. If it waits indefinitely, approvals park until
  answered. If it caps out, the shim denies with "approval pending" and the
  answer arrives via `--resume` instead — same states, same tools, just a
  restart rather than a resume mid-turn.
- **A read-only status page**, for glancing at the queue without starting a
  conversation.
