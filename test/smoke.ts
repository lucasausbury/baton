import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store, type StoreEvent } from "../src/core/store.ts";
import { StateError } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "awm-smoke-"));
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
  assert.equal(store.authWorker("awm_wrong"), null);
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
  path: "/Users/lucas/src/alexandria",
  defaultProfileId: profile.id,
  context: "Rust, uses nextest.",
});

check("register is idempotent and updates path", () => {
  const again = store.registerProject({
    name: "alexandria",
    workerId: worker.id,
    path: "/Users/lucas/src/alexandria2",
  });
  assert.equal(again.id, project.id);
  assert.equal(again.path, "/Users/lucas/src/alexandria2");
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
  assert.equal(item.project.path, "/Users/lucas/src/alexandria2");
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

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
