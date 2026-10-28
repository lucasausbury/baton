import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { Store, type StoreEvent } from "../src/core/store.ts";
import { StateError } from "../src/core/types.ts";

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

const profile = store.createProfile({
  workerId: worker.id,
  label: "opus-personal",
  command: "claude",
  args: ["--model", "opus"],
  env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" },
  credentialRef: "personal",
});

check("profile id namespaces by worker", () =>
  assert.equal(profile.id, "macbook-pro:opus-personal"));

check("profile round-trips args and env", () => {
  const got = store.getProfile(profile.id);
  assert.deepEqual(got.args, ["--model", "opus"]);
  assert.equal(got.env.CLAUDE_CONFIG_DIR, "~/.claude-personal");
});

const project = store.registerProject({
  name: "alexandria",
  workerId: worker.id,
  path: "/Users/you/src/alexandria",
  defaultProfileId: profile.id,
  context: "Rust, uses nextest.",
});

check("register is idempotent and updates path", () => {
  const again = store.registerProject({
    name: "alexandria",
    workerId: worker.id,
    path: "/Users/you/src/alexandria2",
  });
  assert.equal(again.id, project.id);
  assert.equal(again.path, "/Users/you/src/alexandria2");
  // COALESCE keeps values the second call omitted.
  assert.equal(again.defaultProfileId, profile.id);
  assert.equal(again.context, "Rust, uses nextest.");
  assert.equal(store.listProjects().length, 1);
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
  const alien = store.createProfile({
    workerId: other.id,
    label: "haiku-cheap",
    command: "claude",
  });
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
  assert.equal(item.project.path, "/Users/you/src/alexandria2");
  assert.equal(item.profile.command, "claude");
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

const scratch = store.createProfile({
  workerId: worker.id,
  label: "scratch",
  command: "claude",
  args: ["--model", "haiku"],
  credentialRef: "client-a",
});

check("re-adding a label replaces the profile outright", () => {
  const again = store.createProfile({
    workerId: worker.id,
    label: "scratch",
    command: "claude",
    credentialRef: "client-b",
  });
  assert.equal(again.id, scratch.id, "the id is stable");
  assert.equal(again.credentialRef, "client-b", "the credential is corrected");
  assert.deepEqual(again.args, [], "and args left off are not quietly kept");
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

// -- per-project permissions --------------------------------------------------

check("a project keeps whatever permissions it was given", () => {
  const p = store.registerProject({
    name: "permissive",
    workerId: worker.id,
    path: "/Users/you/src/permissive",
    defaultProfileId: profile.id,
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Bash(git status*)"],
    deniedTools: ["Bash(rm *)"],
  });
  assert.equal(p.permissionMode, "acceptEdits");
  assert.deepEqual(p.allowedTools, ["Read", "Bash(git status*)"]);
  assert.deepEqual(p.deniedTools, ["Bash(rm *)"]);
});

check("re-registering without permissions keeps the ones already set", () => {
  const again = store.registerProject({
    name: "permissive",
    workerId: worker.id,
    path: "/Users/you/src/permissive",
  });
  assert.equal(again.permissionMode, "acceptEdits", "the mode survives");
  assert.deepEqual(again.allowedTools, ["Read", "Bash(git status*)"], "and the list");
});

check("an empty list is a real answer, not an omission", () => {
  const cleared = store.registerProject({
    name: "permissive",
    workerId: worker.id,
    path: "/Users/you/src/permissive",
    allowedTools: [],
  });
  assert.deepEqual(cleared.allowedTools, [], "allowing nothing is settable");
  assert.deepEqual(cleared.deniedTools, ["Bash(rm *)"], "and does not disturb the rest");
});

check("a project with no permissions set reads as defaults", () => {
  const plain = store.registerProject({
    name: "plain",
    workerId: worker.id,
    path: "/Users/you/src/plain",
    defaultProfileId: profile.id,
  });
  assert.equal(plain.permissionMode, null);
  assert.deepEqual(plain.allowedTools, []);
  assert.deepEqual(plain.deniedTools, []);
});

check("a misspelt permission mode is refused at the door", () => {
  assert.throws(
    () =>
      store.registerProject({
        name: "typo",
        workerId: worker.id,
        path: "/Users/you/src/typo",
        defaultProfileId: profile.id,
        permissionMode: "acceptAllTheThings" as never,
      }),
    /unknown permission mode/i,
  );
  assert.throws(() => store.getProject("typo"), /no project/i, "and nothing was written");
});

// -- enrollment ---------------------------------------------------------------

check("enrolling sets up a machine, its profiles and its projects at once", () => {
  const result = store.enroll({
    name: "Studio Mac",
    platform: "darwin",
    profiles: [
      { label: "Personal", command: "claude", credentialRef: "personal" },
      { label: "Client A", command: "claude", credentialRef: "client-a" },
    ],
    projects: [
      {
        name: "brochure",
        path: "/Users/you/src/brochure",
        profileLabel: "Client A",
        permissionMode: "acceptEdits",
        allowedTools: ["Read"],
      },
    ],
  });

  assert.equal(result.worker.id, "studio-mac");
  assert.match(result.token, /^baton_[0-9a-f]{32}$/);
  assert.equal(result.profileIds.length, 2);
  assert.equal(store.authWorker(result.token)?.id, "studio-mac", "the token works immediately");

  const project = store.getProject("brochure");
  assert.equal(project.defaultProfileId, "studio-mac:client-a", "the named profile is the default");
  assert.equal(project.permissionMode, "acceptEdits");
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
  assert.equal(store.getProject("brochure").path, before.path, "the project is still there");
});

check("a project naming a profile that is not being enrolled rolls the whole thing back", () => {
  assert.throws(
    () =>
      store.enroll({
        name: "Doomed Box",
        profiles: [{ label: "Personal", command: "claude" }],
        projects: [{ name: "orphan", path: "/tmp/orphan", profileLabel: "Nope" }],
      }),
    /which is not one of the profiles/i,
  );
  assert.throws(() => store.getWorker("doomed-box"), /no worker/i, "no half-made machine");
  assert.throws(() => store.getProject("orphan"), /no project/i);
});

// -- migrating a database that predates those columns -------------------------

check("an older database gains the permission columns without losing anything", () => {
  const path = join(dir, "older.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT,
      token_hash TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      worker_id TEXT NOT NULL REFERENCES workers(id), path TEXT NOT NULL,
      default_profile_id TEXT, context TEXT,
      created_at TEXT NOT NULL, archived_at TEXT
    );
  `);
  old.prepare("INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?)").run(
    "old-box", "Old Box", "linux", "hash", null, "2026-01-01T00:00:00.000Z",
  );
  old.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy", "legacy", "old-box", "/srv/legacy", null, "notes worth keeping",
    "2026-01-01T00:00:00.000Z", null,
  );
  old.close();

  // Opening it is the migration: the columns are added in place.
  const migrated = openDb(path);
  const store2 = new Store(migrated);
  const project = store2.getProject("legacy");

  assert.equal(project.path, "/srv/legacy", "the row survived");
  assert.equal(project.context, "notes worth keeping");
  assert.equal(project.permissionMode, null, "and reads as unset, not as broken");
  assert.deepEqual(project.allowedTools, []);
  assert.deepEqual(project.deniedTools, []);

  // Running it again must be a no-op rather than an error.
  migrated.close();
  const twice = openDb(path);
  assert.equal(new Store(twice).getProject("legacy").path, "/srv/legacy");
  twice.close();
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
