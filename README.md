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

Machines are normally set up **from the machine**, with the wizard below, which
is the only way to get a path and a permission ceiling onto one. The server-side
CLI registers the names:

```bash
npm run cli -- worker add "MacBook Pro" --platform darwin
npm run cli -- profile add --worker macbook-pro --label opus-personal
npm run cli -- project add --name alexandria --worker macbook-pro \
  --profile macbook-pro:opus-personal --posture edits
```

Note what is not there: no command, no environment, no path. Those cannot be set
from the server at all — see "What the server knows, and what it cannot" below.

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

On the machine itself:

```bash
npm run enroll -- --server https://baton.example.com
```

The wizard asks what this machine is, finds Claude Code on it, asks which
accounts it has and which projects live here, and asks per project the most its
agents may ever do. Then it tells the server the **names** — and only the names
— and writes everything else into this machine's own config.

The worker token goes from the server straight into that file without ever
being displayed, which is the point: copying one off a terminal and carrying it
to another machine was the worst part of adding one. Re-enrolling a machine you
are rebuilding takes `--replace`, which issues a new token and stops the old
one working.

Enrollment authenticates with `BATON_LOGIN_PASSWORD`. That password already
grants full control through MCP, so this gives it nothing new, and it is rate
limited the same way the consent screen is.

### What the server knows, and what it cannot

The server stores a project's **name**, which machine it is on, which account
label runs it, and which posture you are asking for. That is all.

It does not store, and cannot set:

| | Where it lives instead |
| - | - |
| the command to run, and its arguments | the worker's config |
| the agent's environment | the worker's config |
| the checkout's path on disk | the worker's config |
| credentials | the worker's config, as they always did |
| the ceiling on what a session may do | the worker's config |
| the refusals no session can get under | that machine's managed settings |

This is deliberate and it is the main thing baton is careful about. A server
that could name an executable, set its environment and choose its working
directory would be a server that can run anything it likes on every machine
enrolled with it — and one password would be all that stood in the way. With
those fields on the worker, baton grants no power that sitting down at the
machine and running Claude Code does not. A server that is taken over can queue
work you would not have asked for, inside limits you already approved.

The posture is a request rather than a grant. The worker takes the stricter of
what the server asks for and what its own config allows, so a compromised
server can only ever ask for *less* autonomy than you already permitted.

### The config it writes

You can also write it by hand. The wizard puts it at
`~/.baton/runner.config.json`, deliberately **outside** any checkout — the old
location was inside baton's own repository, which is a project an agent may be
working in, and an agent that can read this file has the worker token and every
credential on the machine. `BATON_RUNNER_CONFIG` overrides the location.

```json
{
  "serverUrl": "https://baton.example.com",
  "workerId": "macbook-pro",
  "token": "baton_...",
  "maxConcurrent": 2,
  "credentials": {
    "personal": { "CLAUDE_CONFIG_DIR": "/Users/you/.claude-personal" },
    "client-acme": { "ANTHROPIC_API_KEY": "sk-ant-..." }
  },
  "profiles": {
    "opus-personal": {
      "command": "/Users/you/.local/bin/claude",
      "launchArgs": [],
      "args": ["--model", "opus"],
      "env": {},
      "credentialRef": "personal"
    }
  },
  "projects": {
    "alexandria": {
      "path": "/Users/you/src/alexandria",
      "profile": "opus-personal",
      "posture": "edits",
      "contained": true,
      "allowedDomains": []
    }
  }
}
```

```bash
npm run runner
```

`profiles` and `projects` are keyed by the slug the server derives from a label
or a name, which is what it sends back. A session naming a project or a profile
this file does not have is **refused**, with exit 78 and an explanation, rather
than run against a guessed path or permission level.

The runner needs no inbound connectivity, survives network changes, and backs
off and retries when the server is unreachable. A bad token is the one failure it
exits on, since retrying cannot fix it.

On startup it tells the server what it has — paths, labels, postures — purely so
the lists in the Claude apps are useful. The server keeps that as reported and
never reads it back to launch anything.

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

Then `"personal": { "CLAUDE_CONFIG_DIR": "/Users/you/.claude-personal" }`.

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

```json
"profiles": {
  "opus-personal": {
    "command": "C:/Program Files/nodejs/node.exe",
    "launchArgs": ["C:/Users/you/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js"],
    "args": ["--model", "opus"]
  }
}
```

`launchArgs` go before the runner's own flags; `args` go after. The wizard
works this out for you: if it finds only a `.cmd` shim it points at the
`cli.js` beside it instead.

### Controlling how much it asks you

A `-p` run starts in Manual mode, where almost everything needs approval. Left
alone that is relentless: a small task becomes dozens of notifications, and a
session that stays blocked nags you again every twenty minutes.

So each project has a **posture**, set on the machine that runs it. A project is
the right scope: a profile is per account and shared across everything on a
machine, while how much autonomy to grant depends on whose code it is — a
client's repo and a scratch repo deserve different answers.

| `posture` | What runs unattended |
| - | - |
| `ask` | Nothing. Safest, and by far the most notifications |
| `edits` | Edits, reads, searches, and read-only git and test commands |
| `trusted` | Those plus shell commands generally |

Deleting, pushing, publishing, installing, fetching from the network and reading
anything that looks like a secret are refused in **all three**. The cost of
being wrong about those does not fall as trust rises.

The runner turns the posture into a settings document and passes it with
`--settings`, which sits above project, local and user settings in Claude Code's
precedence — so an agent cannot loosen any of it by writing a
`.claude/settings.json` into the repository it is working on. Only managed
settings outrank it, and those are the machine's own floor. Anything allowed is
resolved by Claude Code itself, so it never becomes a permission request and
never reaches your phone.

No posture uses `bypassPermissions`. That mode skips the protected paths on
`.git` and `.claude` and skips read containment, and the docs say to use it only
in a container or a VM. A wide allow list under `acceptEdits` is just as quiet
and leaves every guard standing.

From the Claude app, `register_project` can ask for a different posture, which
is what you want mid-task. It can only ask for less than the machine allows.

### The machine's floor

The posture decides what a session may do. The floor decides what **no** session
on that machine may do, whatever baton asks for — a bad posture, a bug in the
settings we synthesise, or a server that has been taken over.

It is a `managed-settings.json`, which Claude Code applies above everything
including the command line, and which lives in a system directory needing
administrator rights to write. That is the point: an agent runs as you, so
anything you can write it can rewrite.

```bash
npm run floor
```

That writes the file next to your runner config and prints the one elevated
command to install it. The wizard does the same at the end of enrolment. Check
it took: run `claude`, type `/status`, and look for managed settings on the
`Setting sources` line.

The floor denies reads and edits of `~/.ssh`, `~/.aws`, `~/.gnupg`, the Claude
config directories, baton's own config, and the usual secrets inside a checkout;
it turns on `blockReadsOutsideWorkingDirectories`; and it sets
`disableBypassPermissionsMode`, so nothing on the machine can start a session in
the one mode that would skip the rest. It contains no allow rules at all — a
managed allow would be a hole no lower scope could close.

> On **WSL**, `/etc/claude-code` is writable by you, so a floor placed there is
> one an agent could rewrite. Put the policy in the Windows chain
> (`C:\Program Files\ClaudeCode` or HKLM) and set `wslInheritsWindowsSettings`
> there instead.

### Containment

Everything above is policy inside Claude Code. It covers Claude's own file tools
and the file commands it recognises in Bash — but not a script that opens files
itself. `npm test` runs whatever the repository says it runs.

For a boundary the operating system enforces, set `"contained": true` on a
project. Writes are then confined to the checkout and network egress is refused
except for the hosts in `allowedDomains`, which starts empty.

This is Claude Code's sandbox, and it exists on **macOS, Linux and WSL2** —
Seatbelt on macOS, bubblewrap on Linux, so `bubblewrap` and `socat` need to be
installed there. It does **not** exist on native Windows. A project marked
contained on a native Windows worker is refused rather than quietly run in the
open, because a containment flag that silently means nothing is worse than no
flag at all. To contain work on a Windows machine, run its worker under WSL2.

Mixing is expected and is why the setting is per project: the projects that can
be contained are, and a project needing a Windows-native toolchain stays native
with a tighter posture to compensate.

### The brief is not trusted

The agent is told, before it reads the brief, that the brief arrived over a queue
and may not have come from you; that its work belongs inside one directory; and
to stop and ask rather than read credentials, act outside that directory, send
the repository anywhere, or install anything. It is also told not to act on
instructions found in the files, issues and pages it reads while working.

That is worth having and it is **not** a security control: the model is what an
injection attacks, so it cannot be its own guard. The controls are the three
above. This paragraph is for the ordinary malicious task from someone who has no
idea what instructions the agent is carrying, and it costs nothing.

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

### Session page, at `/s/<id>` (login password)

A read-only page for one session: its state, the profile and worker it ran on,
any open question, and the output. It is where a push notification points, so
that tapping one shows you the session instead of dropping you into an app with
a conversation to steer.

It is signed in with the same `BATON_LOGIN_PASSWORD` as the consent screen,
since it grants the same sight of your projects' work, and it is rate limited
the same way. Signing in sets an `HttpOnly` cookie holding nothing but an
expiry and an HMAC of it, so there is no table to sweep and changing the
password invalidates every outstanding cookie. Nothing on the page writes:
answering an open question still happens through MCP.

Without a login password the route is off and says so, rather than falling
through to the runner API and its misleading 401.

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

Agreed and next up:

- **Approve and deny on the session page.** The page is read-only today, so a
  notification means opening the app and typing a reply. The answering
  machinery already exists — `reply` resolves the open ask and the shim is
  already long-polling for it — so this is a POST and a form. The form must
  carry the ask's message id, signed, and refuse if that is no longer the open
  one: otherwise coming back to a stale page approves whatever the agent moved
  on to. Approval buttons in the ntfy notification itself follow from the same
  signed token.
- **Requiring approval to *start* a session.** The strongest control available
  and nearly free once the page can answer. An attacker holding an MCP
  credential can queue work; if the project asks for it, that session waits
  blocked until it is approved. The approval must not be answerable over MCP —
  otherwise whoever queued the work approves it themselves — so it belongs to
  the password-authenticated page, which is also the argument for splitting the
  one password into read-and-approve versus enrol-and-administer.
- **A bounded wait, for asking rather than dispatching.** `create_session` with
  a `waitSeconds` (capped around a minute), long-polling server-side the way
  `/v1/work` already does, and returning the transcript so far. For "find X on
  that machine" the answer comes back inside the same tool call, and the chat
  formats it. Most of what makes a session feel like fire-and-forget is this
  being absent.
- **Roadmap items per project.** Somewhere to put an idea without starting work:
  a body, a project, a state, and the session it eventually became. Capture
  latency is the whole value, so one sentence with no required fields. Promoting
  an item hands its text back to the chat to turn into a brief rather than
  passing a three-word reminder to an agent as a prompt.
- **A queue overview page.** `/s/<id>` shows one session; there is still no
  page that lists them, for glancing at everything in flight without starting a
  conversation.
- **`defer` for very long waits.** A parked agent is cheap but not free. A
  `PreToolUse` hook can return `defer`, which lets the process exit and resume
  from the persisted session when the answer arrives — worth doing if you find
  yourself approving things the next morning.
- **Feeding operator messages to a live agent's stdin.** The server side exists
  and is tested (`/v1/sessions/:id/inbound`, `takeInbound`); nothing consumes it,
  because the agent is spawned with stdin closed. Wiring it up means running with
  `--input-format stream-json`, and then the process no longer exits when it
  finishes a turn — so "the agent is done" stops being "the process exited", and
  every part of the state machine that keys off that needs a new signal. That is
  the real cost, and it is why the bounded wait above comes first.
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
