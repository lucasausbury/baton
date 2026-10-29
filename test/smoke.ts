import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { Store, type StoreEvent } from "../src/core/store.ts";
import { StateError } from "../src/core/types.ts";
import { PERMISSION_PRESETS, sessionSettings, stricter } from "../src/core/permissions.ts";
import { floorSettings, floorTarget } from "../src/core/managed.ts";
import { cleanPath } from "../src/core/paths.ts";

const dir = mkdtempSync(join(tmpdir(), "baton-smoke-"));
const db = openDb(join(dir, "test.db"));
const store = new Store(db);
const events: StoreEvent[] = [];
store.onEvent((e) => events.push(e));

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// -- registration ------------------------------------------------------------

const { worker, token } = store.createWorker("MacBook Pro", "darwin");

check("worker gets a slug id", () => assert.equal(worker.id, "macbook-pro"));

check("token authenticates", () => {
  assert.equal(store.authWorker(token)?.id, "macbook-pro");
  assert.equal(store.authWorker("baton_wrong"), null);
});

const profile = store.createProfile({ workerId: worker.id, label: "opus-personal" });

check("profile id namespaces by worker", () =>
  assert.equal(profile.id, "macbook-pro:opus-personal"));

check("a profile is a label and nothing a server could run", () => {
  // Deliberately the whole shape. If a command, an environment or a credential
  // ever reappears here, a server compromise reaches every enrolled machine.
  assert.deepEqual(Object.keys(store.getProfile(profile.id)).sort(), [
    "createdAt",
    "id",
    "label",
    "workerId",
  ]);
});

const project = store.registerProject({
  name: "alexandria",
  workerId: worker.id,
  defaultProfileId: profile.id,
  context: "Rust, uses nextest.",
  requestedPosture: "edits",
});

check("register is idempotent and keeps what it is not given", () => {
  const again = store.registerProject({ name: "alexandria", workerId: worker.id });
  assert.equal(again.id, project.id);
  // COALESCE keeps values the second call omitted.
  assert.equal(again.defaultProfileId, profile.id);
  assert.equal(again.context, "Rust, uses nextest.");
  assert.equal(again.requestedPosture, "edits");
  assert.equal(store.listProjects().length, 1);
});

check("a project carries no path for a server to repoint", () => {
  assert.deepEqual(Object.keys(project).sort(), [
    "archivedAt",
    "context",
    "createdAt",
    "defaultProfileId",
    "id",
    "name",
    "requestedPosture",
    "workerId",
  ]);
});

check("project lookup accepts id or name", () =>
  assert.equal(store.getProject("alexandria").id, store.getProject(project.id).id));

// -- a session's life --------------------------------------------------------

const session = store.createSession({
  project: "alexandria",
  prompt: "Bump the nextest config and make the suite green.",
  title: "nextest bump",
});

check("new session is queued", () => {
  assert.equal(session.state, "queued");
  assert.equal(session.runCount, 0);
  assert.equal(session.workerId, worker.id);
});

check("a profile on the wrong worker is refused", () => {
  const other = store.createWorker("Windows Desktop", "win32").worker;
  const alien = store.createProfile({ workerId: other.id, label: "haiku-cheap" });
  assert.throws(
    () => store.createSession({ project: "alexandria", prompt: "x", profileId: alien.id }),
    StateError,
  );
});

check("another worker sees no work", () => assert.equal(store.claimWork("windows-desktop").length, 0));

const claimed = store.claimWork(worker.id);

check("claim hands over one item with its prompt", () => {
  assert.equal(claimed.length, 1);
  const item = claimed[0]!;
  assert.equal(item.session.id, session.id);
  assert.equal(item.session.state, "running");
  assert.equal(item.resume, false);
  assert.match(item.prompt, /nextest config/);
  assert.equal(item.project.name, "alexandria", "the runner is told the name");
  assert.equal(item.profile.label, "opus-personal", "and the account's label");
  assert.equal(item.project.requestedPosture, "edits", "and what autonomy was asked for");
});

check("a claimed session is not handed out twice", () =>
  assert.equal(store.claimWork(worker.id).length, 0));

check("markStarted records the run", () => {
  const started = store.markStarted(session.id);
  assert.equal(started.runCount, 1);
  assert.ok(started.startedAt);
});

store.appendOutput(session.id, "Reading nextest.toml...");

// -- the interactive hole ----------------------------------------------------

const ask = store.ask({
  sessionId: session.id,
  kind: "approval_request",
  body: "Run `cargo update -p nextest`?",
  payload: { tool_name: "Bash", tool_input: { command: "cargo update -p nextest" } },
});

check("asking parks the session", () => {
  assert.equal(store.getSession(session.id).state, "blocked");
  assert.equal(store.openAsk(session.id)?.id, ask.id);
  assert.equal(store.answerTo(ask.id), null);
});

check("blocking raises a notification", () => {
  const last = events.at(-1)!;
  assert.equal(last.type, "blocked");
  assert.match(last.message!.body, /cargo update/);
});

const decision = store.reply({ sessionId: session.id, body: "allow" });

check("replying unparks and resolves the ask", () => {
  assert.equal(store.getSession(session.id).state, "running");
  assert.equal(store.answerTo(ask.id)?.id, decision.id);
  assert.equal(store.openAsk(session.id), null);
  // An approval request is answered by a decision, not a plain answer.
  assert.equal(decision.kind, "decision");
});

check("payload survives the round trip", () => {
  const got = store.messages(session.id).find((m) => m.id === ask.id)!;
  assert.deepEqual(got.payload, {
    tool_name: "Bash",
    tool_input: { command: "cargo update -p nextest" },
  });
});

// -- finishing ---------------------------------------------------------------

check("a final message does not block anything", () => {
  store.appendOutput(session.id, "All 48 tests pass. Nothing left to do.", "result");
  const done = store.finishSession(session.id, 0);
  assert.equal(done.state, "finished");
  assert.equal(store.openAsk(session.id), null);
  assert.ok(done.endedAt);
});

check("finished sessions sit unread until acknowledged", () => {
  assert.equal(store.listSessions({ unseen: true }).length, 1);
  assert.equal(store.acknowledge([session.id]), 1);
  assert.equal(store.listSessions({ unseen: true }).length, 0);
  assert.equal(store.acknowledge([session.id]), 0);
});

check("a finished session takes no more output", () =>
  assert.throws(() => store.appendOutput(session.id, "late"), StateError));

check("an illegal transition is refused", () =>
  assert.throws(() => store.finishSession(session.id, 1), StateError));

// -- resuming ----------------------------------------------------------------

check("resume re-queues and asks the runner to resume", () => {
  const resumed = store.resumeSession(session.id, "Also update the CI matrix.");
  assert.equal(resumed.state, "queued");
  assert.equal(resumed.exitCode, null);
  const item = store.claimWork(worker.id)[0]!;
  assert.equal(item.resume, true, "run_count > 0 means resume, not a cold start");
  assert.equal(item.prompt, "Also update the CI matrix.");
  assert.equal(item.session.id, session.id, "the row id is the agent session id");
});

check("resume is refused while the agent is live", () =>
  assert.throws(() => store.resumeSession(session.id, "no"), StateError));

// -- crash recovery ----------------------------------------------------------

check("a claim that never started goes back on the queue", () => {
  assert.deepEqual(store.requeueStaleClaims(0), [session.id]);
  const back = store.getSession(session.id);
  assert.equal(back.state, "queued");
  assert.equal(back.claimedAt, null);
  const item = store.claimWork(worker.id)[0]!;
  assert.equal(item.prompt, "Also update the CI matrix.", "the prompt is redelivered intact");
});

check("a started session is left alone by the reaper", () => {
  store.markStarted(session.id);
  assert.deepEqual(store.requeueStaleClaims(0), []);
});

check("the message log is the full history", () => {
  const log = store.messages(session.id);
  assert.deepEqual(
    log.map((m) => `${m.direction}:${m.kind}`),
    [
      "in:prompt",
      "out:output",
      "out:approval_request",
      "in:decision",
      "out:result",
      "in:prompt",
    ],
  );
});

// -- editing and removing profiles --------------------------------------------

const scratch = store.createProfile({ workerId: worker.id, label: "scratch" });

check("re-adding a label is idempotent", () => {
  const again = store.createProfile({ workerId: worker.id, label: "Scratch" });
  assert.equal(again.id, scratch.id, "the id is stable across spelling");
  assert.equal(again.label, "Scratch", "the label is corrected");
  assert.equal(again.createdAt, scratch.createdAt, "but its age survives");
  assert.equal(store.listProfiles(worker.id).filter((p) => p.id === scratch.id).length, 1);
});

check("an unused profile can be deleted", () => {
  store.deleteProfile(scratch.id);
  assert.throws(() => store.getProfile(scratch.id), /no profile/);
});

check("deleting an unknown profile says so", () =>
  assert.throws(() => store.deleteProfile("macbook-pro:nope"), /no profile/));

check("a profile a project defaults to cannot be deleted", () => {
  assert.throws(
    () => store.deleteProfile(profile.id),
    (err: Error) => {
      assert.match(err.message, /cannot delete/i);
      assert.match(err.message, /alexandria/, "it names the project in the way");
      assert.match(err.message, /same label/, "and points at the way to fix it instead");
      return true;
    },
  );
  assert.ok(store.getProfile(profile.id), "and it is still there");
});

check("a profile with sessions against it cannot be deleted", () => {
  // alexandria's default is cleared, so only the session history is in the way.
  db.prepare(`UPDATE projects SET default_profile_id = NULL WHERE name = 'alexandria'`).run();
  assert.throws(() => store.deleteProfile(profile.id), /session/i);
});

// -- paths people paste -------------------------------------------------------

check("a path pasted from Explorer loses its quotes", () => {
  // "Copy as path" in Windows Explorer gives exactly this. Left alone, the
  // leading quote makes the string relative, and it used to be resolved
  // against the working directory -- so the wizard rejected a path that was
  // plainly there.
  assert.equal(cleanPath('"C:\\Users\\you\\src\\thing"'), "C:\\Users\\you\\src\\thing");
  assert.equal(cleanPath("'/Users/you/src/thing'"), "/Users/you/src/thing");
  assert.equal(cleanPath('  "/srv/app"  '), "/srv/app");
});

check("an unquoted path is left exactly as it is", () => {
  assert.equal(cleanPath("/Users/you/src/thing"), "/Users/you/src/thing");
  assert.equal(cleanPath("C:\\src\\thing"), "C:\\src\\thing");
  // A lone quote is not a pair, so it is not a quoted path and nothing is
  // stripped -- the answer is wrong either way, and silently changing it would
  // hide that.
  assert.equal(cleanPath('"/srv/app'), '"/srv/app');
  assert.equal(cleanPath(""), "");
  assert.equal(cleanPath('"'), '"');
});

check("a tilde is expanded, because no shell was there to do it", () => {
  assert.equal(cleanPath("~"), homedir());
  assert.equal(cleanPath("~/src/thing"), join(homedir(), "/src/thing"));
  assert.ok(!cleanPath("~weird/path").startsWith(homedir()), "but only a real home prefix");
});

// -- postures -----------------------------------------------------------------

check("a project keeps the posture it was asked for", () => {
  const p = store.registerProject({
    name: "permissive",
    workerId: worker.id,
    defaultProfileId: profile.id,
    requestedPosture: "trusted",
  });
  assert.equal(p.requestedPosture, "trusted");
});

check("re-registering without a posture keeps the one already set", () => {
  const again = store.registerProject({ name: "permissive", workerId: worker.id });
  assert.equal(again.requestedPosture, "trusted");
});

check("a project with no posture asked for defers to the machine", () => {
  const plain = store.registerProject({
    name: "plain",
    workerId: worker.id,
    defaultProfileId: profile.id,
  });
  assert.equal(plain.requestedPosture, null, "null means whatever the worker allows");
});

check("a misspelt posture is refused at the door", () => {
  assert.throws(
    () =>
      store.registerProject({
        name: "typo",
        workerId: worker.id,
        defaultProfileId: profile.id,
        requestedPosture: "trustMeBro" as never,
      }),
    /unknown posture/i,
  );
  assert.throws(() => store.getProject("typo"), /no project/i, "and nothing was written");
});

check("the stricter posture always wins", () => {
  assert.equal(stricter("ask", "trusted"), "ask");
  assert.equal(stricter("trusted", "ask"), "ask");
  assert.equal(stricter("edits", "trusted"), "edits");
  assert.equal(stricter("edits", "edits"), "edits");
});

check("no posture uses the mode that would skip the guards", () => {
  // bypassPermissions skips the protected paths on .git and .claude and skips
  // read containment, so it must never be one of the answers.
  for (const preset of PERMISSION_PRESETS) {
    assert.notEqual(preset.permissionMode, "bypassPermissions", `${preset.key} must not bypass`);
  }
});

// The runner only reaches the contained branch on a platform that has a
// sandbox, so on Windows the end-to-end test takes the refusal path instead.
// Check the document itself here, where the platform does not matter.
check("a contained project asks for a sandbox that fails shut", () => {
  const settings = sessionSettings({
    posture: "trusted",
    contained: true,
    allowedDomains: ["registry.npmjs.org"],
  });
  const sandbox = settings.sandbox as Record<string, unknown>;
  assert.equal(sandbox.enabled, true);
  assert.equal(
    sandbox.failIfUnavailable,
    true,
    "a machine missing bubblewrap must refuse to start, not run everything in the open",
  );
  assert.equal(
    sandbox.allowUnsandboxedCommands,
    false,
    "and a command must not be retried outside the sandbox when it fails inside it",
  );
  assert.deepEqual(sandbox.network, { allowedDomains: ["registry.npmjs.org"] });
});

check("an uncontained project still gets every rule the sandbox is not", () => {
  const settings = sessionSettings({ posture: "trusted", contained: false, allowedDomains: [] });
  assert.deepEqual(settings.sandbox, { enabled: false }, "said out loud, not left absent");
  const permissions = settings.permissions as { deny: string[] };
  assert.ok(permissions.deny.includes("Read(~/.ssh/**)"), "policy still applies");
});

check("network egress is refused by default, not merely unconfigured", () => {
  const settings = sessionSettings({ posture: "trusted", contained: true, allowedDomains: [] });
  const sandbox = settings.sandbox as { network: { allowedDomains: string[] } };
  assert.deepEqual(sandbox.network.allowedDomains, [], "no hosts unless someone names them");
});

check("no deny rule is written against a tool that never matches paths", () => {
  // Claude Code accepts Write(path), Glob(path) and NotebookEdit(path) rules
  // and then never matches a file against them. A rule like that looks like
  // protection and is not, which is worse than having none.
  const deny = (sessionSettings({ posture: "ask", contained: false, allowedDomains: [] })
    .permissions as { deny: string[] }).deny;
  for (const rule of deny) {
    assert.ok(
      !/^(Write|Glob|NotebookEdit|MultiEdit)\(/.test(rule),
      `${rule} would be accepted and never matched`,
    );
  }
});

check("the machine's floor refuses and never grants", () => {
  const floor = floorSettings().permissions as Record<string, unknown>;
  assert.ok(Array.isArray(floor.deny) && floor.deny.length > 0, "it denies things");
  assert.ok(!("allow" in floor), "a managed allow rule would be a hole nothing could close");
  assert.equal(floor.disableBypassPermissionsMode, "disable");
  assert.equal(floor.blockReadsOutsideWorkingDirectories, true);
});

check("the floor goes somewhere only an administrator can write", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const target = floorTarget(platform);
    assert.equal(target.needsElevation, true, `${platform} needs elevation`);
    assert.match(target.path, /managed-settings\.json$/);
    assert.match(target.install("/tmp/staged.json"), /staged\.json/, "and says how to install it");
  }
  // The legacy Windows location is not read by Claude Code, so naming it would
  // produce a floor that silently does nothing.
  assert.ok(!floorTarget("win32").path.includes("ProgramData"));
});

// -- enrollment ---------------------------------------------------------------

check("enrolling sets up a machine, its profiles and its projects at once", () => {
  const result = store.enroll({
    name: "Studio Mac",
    platform: "darwin",
    profiles: [{ label: "Personal" }, { label: "Client A" }],
    projects: [{ name: "brochure", profileLabel: "Client A", posture: "edits" }],
  });

  assert.equal(result.worker.id, "studio-mac");
  assert.match(result.token, /^baton_[0-9a-f]{32}$/);
  assert.equal(result.profileIds.length, 2);
  assert.equal(store.authWorker(result.token)?.id, "studio-mac", "the token works immediately");

  const project = store.getProject("brochure");
  assert.equal(project.defaultProfileId, "studio-mac:client-a", "the named profile is the default");
  assert.equal(project.requestedPosture, "edits");
});

check("enrolling a machine that already exists is refused by default", () => {
  assert.throws(
    () => store.enroll({ name: "Studio Mac", platform: "darwin" }),
    /already registered/i,
  );
});

check("replacing rotates the token and keeps the projects", () => {
  const before = store.getProject("brochure");
  const result = store.enroll({ name: "Studio Mac", platform: "darwin", replace: true });
  assert.match(result.token, /^baton_/);
  assert.equal(store.authWorker(result.token)?.id, "studio-mac");
  assert.equal(
    store.getProject("brochure").requestedPosture,
    before.requestedPosture,
    "the project is still there",
  );
});

check("a worker's reported inventory round-trips, and a broken one is not fatal", () => {
  store.setInventory("studio-mac", {
    projects: [
      { id: "brochure", path: "/Users/you/src/brochure", profile: "client-a", posture: "edits", contained: true },
    ],
    profiles: [{ label: "Client A", credential: "client-a" }],
  });
  const reported = store.getWorker("studio-mac");
  assert.equal(reported.inventory?.projects[0]?.path, "/Users/you/src/brochure");
  assert.equal(reported.inventory?.projects[0]?.contained, true);
  assert.ok(reported.inventoryAt, "and when it was reported");

  // It is written by another machine, so a shape we do not recognise must
  // degrade to "nothing reported" rather than break every list call.
  db.prepare(`UPDATE workers SET inventory_json = 'not json at all' WHERE id = 'studio-mac'`).run();
  assert.equal(store.getWorker("studio-mac").inventory, null);
  assert.equal(store.listWorkers().length > 0, true, "and listing still works");
});

check("a project naming a profile that is not being enrolled rolls the whole thing back", () => {
  assert.throws(
    () =>
      store.enroll({
        name: "Doomed Box",
        profiles: [{ label: "Personal" }],
        projects: [{ name: "orphan", profileLabel: "Nope" }],
      }),
    /which is not one of the profiles/i,
  );
  assert.throws(() => store.getWorker("doomed-box"), /no worker/i, "no half-made machine");
  assert.throws(() => store.getProject("orphan"), /no project/i);
});

// -- migrating a database from before the worker held its own config ----------

/** A database in the shape baton used when the server chose what to run. */
function oldDatabase(path: string): void {
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT,
      token_hash TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      label TEXT NOT NULL, command TEXT NOT NULL,
      launch_args_json TEXT NOT NULL DEFAULT '[]',
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      credential_ref TEXT, created_at TEXT NOT NULL,
      UNIQUE (worker_id, label)
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      worker_id TEXT NOT NULL REFERENCES workers(id), path TEXT NOT NULL,
      default_profile_id TEXT, context TEXT,
      permission_mode TEXT,
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      denied_tools_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, archived_at TEXT
    );
  `);
  old.prepare("INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?)").run(
    "old-box", "Old Box", "linux", "hash", null, "2026-01-01T00:00:00.000Z",
  );
  old.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "old-box:claude", "old-box", "claude", "/usr/local/bin/claude", "[]",
    '["--model","opus"]', '{"ANTHROPIC_API_KEY":"sk-ant-oops"}', "personal",
    "2026-01-01T00:00:00.000Z",
  );
  old.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy", "legacy", "old-box", "/srv/legacy", "old-box:claude", "notes worth keeping",
    "bypassPermissions", '["Bash"]', "[]", "2026-01-01T00:00:00.000Z", null,
  );
  old.close();
}

check("migrating drops what the server must no longer be able to choose", () => {
  const path = join(dir, "older.db");
  oldDatabase(path);

  // Opening it is the migration.
  const migrated = openDb(path);
  const store2 = new Store(migrated);

  const columns = (table: string): string[] =>
    (migrated.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );

  // The point of the migration. A stored command, environment or path left
  // behind would be the thing being removed, still sitting there -- including,
  // in this fixture, an API key that was never meant to live on the server.
  for (const column of ["command", "launch_args_json", "args_json", "env_json", "credential_ref"]) {
    assert.ok(!columns("profiles").includes(column), `profiles.${column} is gone`);
  }
  for (const column of ["path", "permission_mode", "allowed_tools_json", "denied_tools_json"]) {
    assert.ok(!columns("projects").includes(column), `projects.${column} is gone`);
  }
  const dump = JSON.stringify(migrated.prepare("SELECT * FROM profiles").all());
  assert.ok(!dump.includes("sk-ant-oops"), "and the secret it held went with it");

  // Everything worth keeping survived.
  const project = store2.getProject("legacy");
  assert.equal(project.context, "notes worth keeping", "the row survived");
  assert.equal(project.defaultProfileId, "old-box:claude");
  assert.equal(project.requestedPosture, null, "and the new column reads as unset, not broken");
  assert.equal(store2.getProfile("old-box:claude").label, "claude");
  assert.equal(store2.getWorker("old-box").inventory, null, "nothing reported yet");

  // Running it again must be a no-op rather than an error.
  migrated.close();
  const twice = openDb(path);
  assert.equal(new Store(twice).getProject("legacy").context, "notes worth keeping");
  twice.close();
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
