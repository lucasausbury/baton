# baton

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

**The agent calls out; the runner does not mediate.** `claude -p` denies
approvals by default, and the supported escape is a permission host named with
`--permission-prompt-tool`. So permission requests *and* clarifying questions
travel from the agent to this server, and the runner only spawns the process,
streams its output, and reports the exit code. No stdin scraping, no
agent-to-agent messenger. The Agent SDK documents that a permission host may
stay pending indefinitely, which is what makes "park until someone picks up the
phone" a supported design rather than a hack.

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
own local config file.

**An ambiguous answer is not consent.** If you reply to an approval with
anything that is not clearly affirmative, the shim denies the call and passes
your words through as guidance, so the agent adapts instead of proceeding.

## Running the server

Needs Node 24+ (uses built-in `node:sqlite` and runs TypeScript directly, so
there is no build step and no native dependency).

```bash
npm install
BATON_ADMIN_TOKEN=$(openssl rand -hex 24) npm run server
```

Register a machine, a profile and a project:

```bash
npm run cli -- worker add "MacBook Pro" --platform darwin
npm run cli -- profile add --worker macbook-pro --label opus-personal \
  --command claude --args "--model opus" --env CLAUDE_CONFIG_DIR=~/.claude-personal \
  --credential personal
npm run cli -- project add --name alexandria --worker macbook-pro \
  --path /Users/lucas/src/alexandria --profile macbook-pro:opus-personal
```

The worker token is printed once and is not recoverable.

### Server configuration

| Variable | Default | Purpose |
| - | - | - |
| `BATON_DB` | `data/baton.db` | SQLite file; the whole system's state |
| `BATON_PORT` / `BATON_HOST` | `8787` / `0.0.0.0` | Listen address |
| `BATON_ADMIN_TOKEN` | — | Bearer token for `/mcp`; required unless bound to loopback |
| `BATON_PUBLIC_URL` | — | Public origin; with a password, enables OAuth for the Claude apps |
| `BATON_LOGIN_PASSWORD` | admin token | Password on the OAuth consent screen |
| `BATON_NTFY_TOPIC` | — | ntfy topic for push; without it notifications are logged only |
| `BATON_NTFY_URL` | `https://ntfy.sh` | Point at a self-hosted ntfy |
| `BATON_PUBLIC_URL` | — | Attaches a click-through URL to pushes |
| `BATON_APPROVAL_WAIT_MS` | 6h | How long an approval request may stay parked |
| `BATON_BLOCKED_REMINDER_MS` | 20m | Re-notify about a session still blocked |

## Running a worker

On each dev machine, create `runner.config.json` (or point `BATON_RUNNER_CONFIG`
at one) and start the runner:

```json
{
  "serverUrl": "https://baton.example.com",
  "workerId": "macbook-pro",
  "token": "baton_...",
  "maxConcurrent": 2,
  "credentials": {
    "personal": { "CLAUDE_CONFIG_DIR": "/Users/lucas/.claude-personal" },
    "client-acme": { "ANTHROPIC_API_KEY": "sk-ant-..." }
  }
}
```

```bash
npm run runner
```

`credentials` maps a profile's `credential_ref` to the environment that profile
needs, and lives only on the worker.

The runner needs no inbound connectivity, survives network changes, and backs
off and retries when the server is unreachable. A bad token is the one failure it
exits on, since retrying cannot fix it.

### Accounts and credentials

Three styles work, and one worker can mix them:

**Subscription login, one config directory per account.** This is the documented
way to keep several Anthropic accounts signed in on one machine: each
`CLAUDE_CONFIG_DIR` has its own settings, history and claude.ai login, and on
macOS the keychain entry is keyed to the directory too, so the accounts really
are isolated. It needs one interactive login per account, once:

```bash
CLAUDE_CONFIG_DIR=~/.claude-personal claude     # log in, then quit
CLAUDE_CONFIG_DIR=~/.claude-client-acme claude  # log in, then quit
```

Then `"personal": { "CLAUDE_CONFIG_DIR": "/Users/lucas/.claude-personal" }`.

**Subscription login without a browser.** `claude setup-token` mints a one-year
OAuth token on a machine you can log in from; put it in a credential as
`CLAUDE_CODE_OAUTH_TOKEN`. Useful for a machine where opening a browser is
awkward. It can only make model requests, and it expires after a year.

**API key.** `"client-acme": { "ANTHROPIC_API_KEY": "sk-ant-..." }`.

The runner **clears every credential variable it inherited** before applying a
profile's own environment. This is not tidiness: `ANTHROPIC_API_KEY` outranks a
subscription login, and under `-p` it is used without prompting, so a single
stray export in the shell that started the runner would silently redirect every
subscription profile onto the wrong account and bill the wrong place. A profile
that names no credential gets the machine's default account, not whatever the
runner happened to inherit.

**Subscription logins expire**, and an unattended session cannot do anything
about it. When a run fails on authentication, the runner says so explicitly and
prints the exact command to fix that account on that machine, because otherwise
it looks like an ordinary failure and every later session on the profile fails
the same way.

### Profiles on Windows

Node will not spawn a `.cmd` or `.bat` without a shell, and running one through
`cmd.exe` would put your prompt, the system prompt and a JSON blob through shell
parsing — so the runner refuses to do it and says so. npm installs Claude Code on
Windows as `claude.cmd`, so a Windows profile needs either `claude.exe` or node
plus the CLI entry point:

```bash
npm run cli -- profile add --worker windows-desktop --label opus-personal \
  --command "C:/Program Files/nodejs/node.exe" \
  --launch-args "C:/Users/lucas/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js" \
  --args "--model opus"
```

`--launch-args` go before the runner's own flags; `--args` go after.

### Controlling how much it asks you

A `-p` run starts in Manual mode, so anything needing approval reaches your
phone. That is correct but can be chatty. Turn it down per profile with
`--args`, for example `--args "--permission-mode acceptEdits"` or
`--args "--allowedTools Read,Edit,Bash(git *)"`. The profile is the right place
for this, since how much autonomy to grant depends on which account and which
project.

## Interfaces

### MCP, at `/mcp` (admin bearer token, or OAuth)

`list_workers`, `list_projects`, `register_project`, `create_session`,
`list_sessions`, `get_session`, `reply`, `resume_session`, `cancel_session`,
`acknowledge`.

There is deliberately no draft-and-approve step: you are already in a Claude
conversation when you create a task, so the planning happens there and calling
`create_session` *is* the sign-off.

Claude Code connects with a static `Authorization` header. The Claude mobile and
desktop apps can't — a custom connector takes OAuth, a static header (beta, for a
limited set of organizations), or nothing, and the MCP authorization spec forbids
a token in the URL. So the server is also its own OAuth authorization server,
with Dynamic Client Registration, PKCE, and refresh-token rotation. With one
user, signing in is proving you know one password. Both routes work at once.

### Runner REST, at `/v1` (worker bearer token)

| Route | Purpose |
| - | - |
| `GET /v1/work?wait=ms&limit=n` | Long-poll; claims up to `n`. `limit=0` asks only about cancellations |
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
npm test             # typecheck, then all four suites

npm run test:smoke   # store and state machine, in-process
npm run test:api     # the server over real HTTP, including a real MCP client
npm run test:runner  # agent spawning, cancellation, and the shim over stdio
npm run test:oauth   # the whole authorization flow, as Claude performs it

# Every test script is namespaced, because "npm run runner" is not a test --
# it starts a real runner that will claim real work from the real server.
npm run typecheck
```

The runner suite drives the permission shim as a real MCP server and asserts the
exact argument list the agent is spawned with, which is where the interesting
mistakes live.

## Not built yet

- **A read-only status page**, for glancing at the queue without starting a
  conversation.
- **`defer` for very long waits.** A parked agent is cheap but not free. A
  `PreToolUse` hook can return `defer`, which lets the process exit and resume
  from the persisted session when the answer arrives — worth doing if you find
  yourself approving things the next morning.
- **Feeding operator messages to a live agent's stdin.** The server side exists
  (`/v1/sessions/:id/inbound`, `--input-format stream-json`) but nothing needs it
  yet, because approvals and questions both go out through the shim.
- **Opt-in rate-limit fallback.** A profile could name a `fallbackProfileId` used
  only when a run fails on a rate limit. It must stay opt-in and explicit: a
  client's conventions arrive through their account, so a silent swap would
  quietly produce work that ignores them. The detection half already exists —
  `rate_limit` is one more category alongside the credential errors the runner
  already recognises.

## One thing to verify on first real use

The field names Claude Code passes to a `--permission-prompt-tool` are not
documented. The shim accepts the plausible spellings (`tool_name`/`toolName`,
`input`/`tool_input`) and logs whatever actually arrives to stderr, which the
runner captures. Check that log on the first real approval and tighten the schema
once it is known.
