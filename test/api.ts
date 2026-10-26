import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/core/store.ts";
import { buildServer } from "../src/server.ts";

const ADMIN = "admin-token-for-tests";

const dir = mkdtempSync(join(tmpdir(), "awm-api-"));
const db = openDb(join(dir, "api.db"));
const store = new Store(db);

const { worker, token } = store.createWorker("MacBook Pro", "darwin");
const profile = store.createProfile({
  workerId: worker.id,
  label: "opus-personal",
  command: "claude",
  args: ["--model", "opus"],
  env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" },
});
store.registerProject({
  name: "alexandria",
  workerId: worker.id,
  path: "/Users/lucas/src/alexandria",
  defaultProfileId: profile.id,
});
const other = store.createWorker("Windows Desktop", "win32");

const server = buildServer(store, { adminToken: ADMIN, host: "127.0.0.1" });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const api = (path: string, init: RequestInit = {}, bearer = token) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

// -- auth --------------------------------------------------------------------

await check("health needs no token", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

await check("a bad worker token is rejected", async () => {
  const res = await api("/v1/work?wait=0", {}, "awm_nope");
  assert.equal(res.status, 401);
});

await check("an empty queue returns empty, not an error", async () => {
  const res = await api("/v1/work?wait=150");
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { work: unknown[] }).work, []);
});

// -- a session, driven the way a runner would ---------------------------------

const session = store.createSession({
  project: "alexandria",
  prompt: "Bump nextest and make the suite green.",
  title: "nextest bump",
});

await check("a held poll returns as soon as work appears", async () => {
  // Queue the work only after the poll is already waiting, which is the real
  // sequence: the runner is parked on an empty queue when a task arrives.
  const polling = api("/v1/work?wait=10000");
  await new Promise((r) => setTimeout(r, 150));
  const second = store.createSession({ project: "alexandria", prompt: "second task" });

  const res = await polling;
  const body = (await res.json()) as { work: { session: { id: string }; prompt: string }[] };
  const ids = body.work.map((w) => w.session.id);
  assert.ok(ids.includes(session.id), "the already-queued session is handed over");
  assert.ok(body.work.length >= 1);
  store.cancelSession(second.id);
});

await check("the work item carries everything needed to spawn", () => {
  const item = store.messages(session.id);
  assert.ok(item.length >= 1);
  const s = store.getSession(session.id);
  assert.equal(s.state, "running");
  assert.equal(s.startedAt, null, "claimed but not yet started");
});

await check("started and output are recorded", async () => {
  const started = await api(`/v1/sessions/${session.id}/started`, { method: "POST" });
  assert.equal(started.status, 200);
  assert.equal(store.getSession(session.id).runCount, 1);

  const out = await api(`/v1/sessions/${session.id}/output`, {
    method: "POST",
    body: JSON.stringify({ body: "Reading nextest.toml..." }),
  });
  assert.equal(out.status, 201);
});

await check("another worker cannot touch this session", async () => {
  const res = await api(
    `/v1/sessions/${session.id}/output`,
    { method: "POST", body: JSON.stringify({ body: "intruder" }) },
    other.token,
  );
  assert.equal(res.status, 404);
});

await check("output requires a body", async () => {
  const res = await api(`/v1/sessions/${session.id}/output`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// -- the approval round trip, which is the whole point ------------------------

await check("an ask is held open until the operator answers", async () => {
  const asking = api(`/v1/sessions/${session.id}/ask?wait=15000`, {
    method: "POST",
    body: JSON.stringify({
      kind: "approval_request",
      body: "Run `cargo update -p nextest`?",
      payload: { tool_name: "Bash", tool_input: { command: "cargo update -p nextest" } },
    }),
  });

  // Give the request time to register the ask and park.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(store.getSession(session.id).state, "blocked", "session parks while asking");
  const open = store.openAsk(session.id);
  assert.ok(open, "the ask is visible to the operator while the agent waits");
  assert.deepEqual(open.payload, {
    tool_name: "Bash",
    tool_input: { command: "cargo update -p nextest" },
  });

  // The operator answers, as the MCP reply tool would.
  store.reply({ sessionId: session.id, body: "allow" });

  const res = await asking;
  const body = (await res.json()) as {
    answered: boolean;
    answer?: { body: string };
  };
  assert.equal(res.status, 200);
  assert.equal(body.answered, true, "the held request resolves with the answer");
  assert.equal(body.answer?.body, "allow");
  assert.equal(store.getSession(session.id).state, "running", "the agent is unparked");
});

await check("an unanswered ask gives up without losing the question", async () => {
  const res = await api(`/v1/sessions/${session.id}/ask?wait=250`, {
    method: "POST",
    body: JSON.stringify({ kind: "question", body: "Which branch should I target?" }),
  });
  const body = (await res.json()) as { answered: boolean; askId: number };
  assert.equal(body.answered, false);
  assert.equal(store.getSession(session.id).state, "blocked", "still parked");
  assert.equal(store.openAsk(session.id)?.id, body.askId, "the question survives for a retry");
});

await check("a cut-off ask can be waited on again", async () => {
  const waiting = api(`/v1/sessions/${session.id}/ask?wait=10000`);
  await new Promise((r) => setTimeout(r, 150));
  store.reply({ sessionId: session.id, body: "target main" });
  const body = (await (await waiting).json()) as { answered: boolean; answer?: { body: string } };
  assert.equal(body.answered, true);
  assert.equal(body.answer?.body, "target main");
  assert.equal(store.getSession(session.id).state, "running");
});

await check("exit settles the session", async () => {
  const res = await api(`/v1/sessions/${session.id}/exit`, {
    method: "POST",
    body: JSON.stringify({ exitCode: 0 }),
  });
  assert.equal(res.status, 200);
  const done = store.getSession(session.id);
  assert.equal(done.state, "finished");
  assert.equal(done.exitCode, 0);
});

await check("a bad exit code is refused", async () => {
  const res = await api(`/v1/sessions/${session.id}/exit`, {
    method: "POST",
    body: JSON.stringify({ exitCode: "nope" }),
  });
  assert.equal(res.status, 400);
});

// -- MCP, driven with a real client ------------------------------------------

await check("the MCP endpoint requires the admin token", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(res.status, 401);
});

const client = new Client({ name: "api-test", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${ADMIN}` } },
  }),
);

await check("tools are advertised", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "acknowledge",
    "cancel_session",
    "create_session",
    "get_session",
    "list_projects",
    "list_sessions",
    "list_workers",
    "register_project",
    "reply",
    "resume_session",
  ]);
});

const callText = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return res.content.map((c) => c.text ?? "").join("\n");
};

await check("list_projects shows the project and its profile", async () => {
  const out = await callText("list_projects");
  assert.match(out, /alexandria/);
  assert.match(out, /opus-personal/);
});

await check("get_session shows the log and marks it read", async () => {
  assert.equal(store.getSession(session.id).seenAt, null);
  const out = await callText("get_session", { sessionId: session.id });
  assert.match(out, /nextest bump/);
  assert.match(out, /cargo update/, "the approval request is in the log");
  assert.match(out, /\[you\/decision\] allow/, "so is the operator's decision");
  assert.ok(store.getSession(session.id).seenAt, "reading acknowledges it");
});

await check("create_session queues work through MCP", async () => {
  const out = await callText("create_session", {
    project: "alexandria",
    prompt: "Update the CI matrix to include 1.84.",
    title: "ci matrix",
  });
  assert.match(out, /Queued/);
  const queued = store.listSessions({ state: "queued" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.title, "ci matrix");
});

await check("create_session warns when the worker looks offline", async () => {
  // A worker that has never called in. `other` does not qualify: it made a
  // request earlier, and any authenticated request counts as a heartbeat even
  // when the request itself is rejected.
  const absent = store.createWorker("Client Laptop", "darwin").worker;
  store.registerProject({
    name: "offline-proj",
    workerId: absent.id,
    path: "C:/src/thing",
    defaultProfileId: store.createProfile({
      workerId: absent.id,
      label: "haiku",
      command: "claude",
    }).id,
  });
  const out = await callText("create_session", { project: "offline-proj", prompt: "x" });
  assert.match(out, /looks offline/);
});

await check("get_session stays inside the tool result limit", async () => {
  const noisy = store.createSession({
    project: "alexandria",
    prompt: "Produce a great deal of output.",
    title: "noisy",
  });
  store.claimWork(worker.id);
  // ~400KB of log, well past the ~150,000-character cap on claude.ai.
  for (let i = 0; i < 40; i++) {
    store.appendOutput(noisy.id, `chunk ${i} ${"x".repeat(10_000)}`);
  }
  store.ask({ sessionId: noisy.id, kind: "question", body: "Should I keep going?" });

  const out = await callText("get_session", { sessionId: noisy.id });
  assert.ok(out.length < 150_000, `expected under 150k chars, got ${out.length}`);
  assert.match(out, /older ones omitted/, "and says what it dropped");
  assert.match(out, /WAITING ON YOU/, "the open ask survives truncation");
  assert.match(out, /Should I keep going\?/);
  assert.match(out, /chunk 39/, "the newest output is kept");
  assert.ok(!out.includes("chunk 0 "), "the oldest is what goes");
  store.reply({ sessionId: noisy.id, body: "no, stop" });
  store.cancelSession(noisy.id);
});

await check("create_session says so when the profile is not the project's own", async () => {
  // A client's conventions arrive through their account, so an override is
  // allowed but must be visible before you walk away from it.
  const alt = store.createProfile({
    workerId: worker.id,
    label: "haiku-cheap",
    command: "claude",
    args: ["--model", "haiku"],
  });
  const out = await callText("create_session", {
    project: "alexandria",
    prompt: "Tidy the imports.",
    profile: alt.id,
  });
  assert.match(out, /Queued/);
  assert.match(out, /Running under haiku-cheap/);
  assert.match(out, /alexandria's usual opus-personal/);
  assert.match(out, /skills and rules .*will not apply/i);
});

await check("and stays quiet when the project's own profile is used", async () => {
  const out = await callText("create_session", {
    project: "alexandria",
    prompt: "Tidy the imports properly.",
  });
  assert.match(out, /Queued/);
  assert.ok(!/Running under/.test(out), "no note when nothing was overridden");
});

await check("reply refuses a session that is not waiting", async () => {
  const out = await callText("reply", { sessionId: session.id, body: "hello?" });
  assert.match(out, /not waiting on anything/);
  assert.match(out, /resume_session/, "and points at the right tool instead");
});

await check("resume_session re-queues a finished session", async () => {
  const out = await callText("resume_session", {
    sessionId: session.id,
    prompt: "Also tag the release.",
  });
  assert.match(out, /resume in place/);
  const item = store.claimWork(worker.id).find((w) => w.session.id === session.id)!;
  assert.equal(item.resume, true);
  assert.equal(item.prompt, "Also tag the release.");
});

await check("list_sessions surfaces blocked sessions first in the header", async () => {
  store.ask({ sessionId: session.id, kind: "question", body: "Which tag format?" });
  const out = await callText("list_sessions");
  assert.match(out, /1 session\(s\) waiting on you/);
  assert.match(out, /\[blocked\]/);
});

await client.close();
await new Promise<void>((r) => server.close(() => r()));
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
