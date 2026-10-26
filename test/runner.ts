import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/core/store.ts";
import { buildServer } from "../src/server.ts";
import { ServerClient } from "../src/runner/client.ts";
import { runAgent } from "../src/runner/agent.ts";
import type { RunnerConfig } from "../src/runner/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "awm-runner-"));

// The fake agent is spawned the same way Claude Code is on Windows: the real
// binary there is a .cmd wrapper that cannot be launched without a shell, so a
// profile names node and puts the entry point in launchArgs.
const fakeAgent = process.execPath;
const fakeAgentLaunchArgs = ["--no-warnings=ExperimentalWarning", join(here, "fake-agent.mjs")];

const db = openDb(join(dir, "runner.db"));
const store = new Store(db);
const { worker, token } = store.createWorker("Test Box", process.platform);

const server = buildServer(store, db, { adminToken: "x", host: "127.0.0.1" });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const client = new ServerClient(base, token);

const argvOut = join(dir, "argv.json");

function profileFor(label: string, mode: string) {
  return store.createProfile({
    workerId: worker.id,
    label,
    command: fakeAgent,
    launchArgs: fakeAgentLaunchArgs,
    args: ["--model", "opus"],
    env: { AWM_TEST_MODE: mode, AWM_TEST_ARGV_OUT: argvOut },
  });
}

const runnerConfig: RunnerConfig = {
  serverUrl: base,
  workerId: worker.id,
  token,
  maxConcurrent: 2,
  credentials: { personal: { CLAUDE_CONFIG_DIR: "/home/lucas/.claude-personal" } },
  retrySeconds: 1,
};

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

function newSession(projectName: string, profileId: string, prompt: string) {
  store.registerProject({
    name: projectName,
    workerId: worker.id,
    path: dir,
    defaultProfileId: profileId,
  });
  store.createSession({ project: projectName, prompt, title: projectName });
  const item = store.claimWork(worker.id).find((w) => w.project.name === projectName);
  assert.ok(item, `expected to claim work for ${projectName}`);
  return item;
}

// -- spawning -----------------------------------------------------------------

const okItem = newSession("proj-ok", profileFor("ok", "ok").id, "Make the suite green.");

await check("a clean run streams output and reports success", async () => {
  const agent = runAgent(okItem, client, runnerConfig);
  await agent.done;

  const session = store.getSession(okItem.session.id);
  assert.equal(session.state, "finished");
  assert.equal(session.exitCode, 0);
  assert.equal(session.runCount, 1, "the runner marked it started");

  const log = store.messages(session.id).map((m) => `${m.kind}:${m.body}`);
  assert.ok(
    log.some((l) => l.includes("Looking at the config")),
    "assistant text reaches the log",
  );
  assert.ok(log.some((l) => l.includes("[tool: Bash]")), "tool calls are summarised");
  assert.ok(
    log.some((l) => l.startsWith("result:") && l.includes("All 48 tests pass")),
    "the final message is recorded as a result",
  );
  assert.ok(log.some((l) => l.includes("$0.123")), "cost is kept");
});

await check("the agent is spawned with the right arguments", () => {
  const spawned = JSON.parse(readFileSync(argvOut, "utf8")) as { argv: string[]; cwd: string };
  const argv = spawned.argv;

  assert.equal(argv[0], "-p");
  assert.equal(argv[1], "Make the suite green.", "the prompt is passed, not piped");

  const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
  assert.equal(flag("--output-format"), "stream-json");
  assert.equal(flag("--permission-prompt-tool"), "mcp__awm__approve");
  assert.equal(
    flag("--session-id"),
    okItem.session.id,
    "the session row id is the agent's own session id",
  );
  assert.ok(!argv.includes("--resume"), "a first run is not a resume");
  assert.ok(argv.includes("--verbose"), "stream-json needs --verbose");

  // The profile's own args must survive, since that is how a model or account
  // gets pinned.
  assert.ok(argv.includes("--model") && argv.includes("opus"));

  const mcp = JSON.parse(flag("--mcp-config") ?? "{}") as {
    mcpServers: { awm: { args: string[]; env: Record<string, string> } };
  };
  assert.match(mcp.mcpServers.awm.args.at(-1) ?? "", /shim\.ts$/);
  assert.equal(mcp.mcpServers.awm.env.AWM_SESSION, okItem.session.id);
  assert.equal(mcp.mcpServers.awm.env.AWM_URL, base);

  assert.equal(spawned.cwd.replace(/\\/g, "/"), dir.replace(/\\/g, "/"), "runs in the project dir");
});

await check("a resumed session is resumed, not restarted", async () => {
  store.resumeSession(okItem.session.id, "Now tag the release.");
  const again = store.claimWork(worker.id).find((w) => w.session.id === okItem.session.id)!;
  assert.equal(again.resume, true);
  const agent = runAgent(again, client, runnerConfig);
  await agent.done;

  const argv = (JSON.parse(readFileSync(argvOut, "utf8")) as { argv: string[] }).argv;
  assert.ok(argv.includes("--resume"), "resume flag is used");
  assert.equal(argv[argv.indexOf("--resume") + 1], okItem.session.id);
  assert.ok(!argv.includes("--session-id"), "and --session-id is not also passed");
  assert.equal(store.getSession(okItem.session.id).runCount, 2);
});

await check("a stray credential in the runner's own shell cannot hijack a profile", async () => {
  // The precedence order is against us: ANTHROPIC_API_KEY beats a subscription
  // login, and under -p it is used without asking. A dev machine very plausibly
  // has one exported, and an inherited CLAUDE_CONFIG_DIR would be just as bad.
  process.env.ANTHROPIC_API_KEY = "sk-ant-leaked-from-the-shell";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-token";
  process.env.CLAUDE_CONFIG_DIR = "/home/lucas/.claude-some-other-account";
  try {
    const profile = store.createProfile({
      workerId: worker.id,
      label: "subscription",
      command: fakeAgent,
      launchArgs: fakeAgentLaunchArgs,
      env: { AWM_TEST_MODE: "ok", AWM_TEST_ARGV_OUT: argvOut },
      credentialRef: "personal",
    });
    const item = newSession("proj-creds", profile.id, "Whose account am I?");
    await runAgent(item, client, runnerConfig).done;

    const seen = (JSON.parse(readFileSync(argvOut, "utf8")) as {
      credentialEnv: Record<string, string>;
    }).credentialEnv;

    assert.equal(
      seen.CLAUDE_CONFIG_DIR,
      "/home/lucas/.claude-personal",
      "the profile's account wins, not the one the runner inherited",
    );
    assert.ok(!("ANTHROPIC_API_KEY" in seen), "an inherited API key must not reach the agent");
    assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in seen), "nor an inherited OAuth token");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

await check("an expired login is reported as a credential problem, with the fix", async () => {
  const profile = store.createProfile({
    workerId: worker.id,
    label: "expired",
    command: fakeAgent,
    launchArgs: fakeAgentLaunchArgs,
    env: { AWM_TEST_MODE: "authfail", AWM_TEST_ARGV_OUT: argvOut },
    credentialRef: "personal",
  });
  const item = newSession("proj-expired", profile.id, "Do some work.");
  await runAgent(item, client, runnerConfig).done;

  const session = store.getSession(item.session.id);
  assert.equal(session.state, "failed");
  const body = store.messages(session.id).map((m) => m.body).join("\n");
  assert.match(body, /credential problem/i, "it is not just another failure");
  assert.match(
    body,
    /CLAUDE_CONFIG_DIR=\/home\/lucas\/\.claude-personal claude \/login/,
    "and names the exact command for that account",
  );
  assert.match(body, new RegExp(worker.id), "on the right machine");
  assert.match(body, /keep failing/i, "and says it affects every future session");
});

await check("a failing run is recorded as failed, with stderr", async () => {
  const item = newSession("proj-fail", profileFor("fail", "fail").id, "Break something.");
  const agent = runAgent(item, client, runnerConfig);
  await agent.done;

  const session = store.getSession(item.session.id);
  assert.equal(session.state, "failed");
  assert.equal(session.exitCode, 2);
  const log = store.messages(session.id).map((m) => m.body);
  assert.ok(log.some((b) => b.includes("[tool failed]") && b.includes("3 tests failed")));
  assert.ok(log.some((b) => b.includes("cargo exited 101")), "stderr is kept on failure");
});

await check("a missing binary fails the session instead of hanging", async () => {
  const bad = store.createProfile({
    workerId: worker.id,
    label: "missing",
    command: join(dir, "definitely-not-here"),
  });
  const item = newSession("proj-missing", bad.id, "Run nothing.");
  const agent = runAgent(item, client, runnerConfig);
  await agent.done;

  const session = store.getSession(item.session.id);
  assert.equal(session.state, "failed");
  assert.equal(session.exitCode, 127);
  assert.ok(
    store.messages(session.id).some((m) => m.body.includes("could not start")),
    "and says why",
  );
});

await check("a .cmd profile is refused with an explanation, not a shell", async () => {
  if (process.platform !== "win32") return; // the guard only applies on Windows
  const bad = store.createProfile({
    workerId: worker.id,
    label: "cmd-wrapper",
    command: "C:/Program Files/nodejs/claude.cmd",
  });
  const item = newSession("proj-cmd", bad.id, "Run via a cmd wrapper.");
  const agent = runAgent(item, client, runnerConfig);
  await agent.done;

  const session = store.getSession(item.session.id);
  assert.equal(session.state, "failed");
  assert.equal(session.exitCode, 126);
  const body = store.messages(session.id).map((m) => m.body).join("\n");
  assert.match(body, /cannot launch a \.cmd/i);
  assert.match(body, /launch args/i, "and says how to fix the profile");
  assert.equal(agent.child, undefined, "nothing was spawned");
});

await check("cancelling kills the agent and leaves it cancelled", async () => {
  const item = newSession("proj-hang", profileFor("hang", "hang").id, "Wait forever.");
  const agent = runAgent(item, client, runnerConfig);

  // Wait until it is actually up before cancelling.
  for (let i = 0; i < 100 && store.getSession(item.session.id).runCount === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(store.getSession(item.session.id).runCount, 1, "agent started");

  store.cancelSession(item.session.id);
  const { cancelled } = await client.getWork(0, 0);
  assert.ok(cancelled.includes(item.session.id), "the runner is told to stop it");

  agent.kill();
  await agent.done;
  assert.equal(
    store.getSession(item.session.id).state,
    "cancelled",
    "a killed session is not reported as failed",
  );
});

await check("a full runner claims nothing but still hears cancellations", async () => {
  store.createSession({ project: "proj-ok", prompt: "queued while busy" });
  const atCapacity = await client.getWork(0, 0);
  assert.equal(atCapacity.work.length, 0, "nothing claimed at limit=0");
  assert.equal(store.listSessions({ state: "queued" }).length, 1, "it stays queued for later");

  const withRoom = await client.getWork(1000, 1);
  assert.equal(withRoom.work.length, 1, "and is handed over once there is room");
  store.cancelSession(withRoom.work[0]!.session.id);
});

// -- the shim, driven as a real MCP server ------------------------------------

const shimItem = newSession("proj-shim", profileFor("shim", "hang").id, "Needs approval.");
store.markStarted(shimItem.session.id);

const shim = new Client({ name: "shim-test", version: "0" });
await shim.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings=ExperimentalWarning", join(here, "..", "src", "runner", "shim.ts")],
    env: {
      ...(process.env as Record<string, string>),
      AWM_SESSION: shimItem.session.id,
      AWM_URL: base,
      AWM_TOKEN: token,
      AWM_ASK_LEG_MS: "4000",
      AWM_ASK_TOTAL_MS: "20000",
    },
    stderr: "pipe",
  }),
);

const callShim = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = (await shim.callTool({ name, arguments: args }, undefined, {
    timeout: 60_000,
  })) as { content: { text?: string }[] };
  return res.content.map((c) => c.text ?? "").join("");
};

await check("the shim advertises the permission host and the question tool", async () => {
  const names = (await shim.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["approve", "ask_operator"]);
});

/** Replies to the session's open ask once one appears. */
async function answerWhenAsked(body: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (store.openAsk(shimItem.session.id)) {
      store.reply({ sessionId: shimItem.session.id, body });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no ask appeared to answer");
}

await check("an approval the operator allows comes back as allow", async () => {
  const pending = callShim("approve", {
    tool_name: "Bash",
    input: { command: "cargo update -p nextest" },
    tool_use_id: "toolu_1",
  });
  await answerWhenAsked("allow");
  const decision = JSON.parse(await pending) as { behavior: string; updatedInput?: unknown };

  assert.equal(decision.behavior, "allow");
  assert.deepEqual(
    decision.updatedInput,
    { command: "cargo update -p nextest" },
    "updatedInput must be echoed back or the call is rejected",
  );
  assert.equal(store.getSession(shimItem.session.id).state, "running", "the agent is unparked");
});

await check("the operator sees what they are approving", () => {
  const asked = store
    .messages(shimItem.session.id)
    .filter((m) => m.kind === "approval_request")
    .at(-1)!;
  assert.match(asked.body, /Bash wants to run/);
  assert.match(asked.body, /cargo update -p nextest/);
  assert.deepEqual(asked.payload, {
    tool_name: "Bash",
    tool_input: { command: "cargo update -p nextest" },
  });
});

await check("a denial comes back as deny, with the reason", async () => {
  const pending = callShim("approve", {
    tool_name: "Bash",
    input: { command: "rm -rf /" },
  });
  await answerWhenAsked("deny - not touching that");
  const decision = JSON.parse(await pending) as { behavior: string; message?: string };
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message ?? "", /not touching that/);
});

await check("an ambiguous reply is not treated as consent", async () => {
  const pending = callShim("approve", { tool_name: "Write", input: { file_path: "/etc/hosts" } });
  await answerWhenAsked("use the staging file instead");
  const decision = JSON.parse(await pending) as { behavior: string; message?: string };
  assert.equal(decision.behavior, "deny", "silence or vagueness must not allow an action");
  assert.match(decision.message ?? "", /staging file/, "but the guidance reaches the agent");
});

await check("a clarifying question is answered in the operator's own words", async () => {
  const questions = [
    {
      question: "Which branch should I target?",
      header: "Branch",
      options: [
        { label: "main", description: "straight to main" },
        { label: "develop", description: "the integration branch" },
      ],
      multiSelect: false,
    },
  ];
  const pending = callShim("approve", {
    tool_name: "AskUserQuestion",
    input: { questions },
  });
  await answerWhenAsked("target release/2.1, not either of those");
  const decision = JSON.parse(await pending) as {
    behavior: string;
    updatedInput?: { questions?: unknown[]; response?: string };
  };
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput?.questions, questions, "questions are passed back");
  assert.equal(decision.updatedInput?.response, "target release/2.1, not either of those");

  const shown = store
    .messages(shimItem.session.id)
    .filter((m) => m.kind === "question")
    .at(-1)!;
  assert.match(shown.body, /Which branch should I target/);
  assert.match(shown.body, /develop/, "the options are shown even though the answer is free text");
});

await check("ask_operator relays a free-form question and its answer", async () => {
  const pending = callShim("ask_operator", {
    question: "The migration will drop a column. Is that intended?",
  });
  await answerWhenAsked("yes, it was deprecated last release");
  assert.match(await pending, /deprecated last release/);
});

await check("an unanswered approval denies rather than hanging forever", async () => {
  const decision = JSON.parse(
    await callShim("approve", { tool_name: "Bash", input: { command: "sleep 1" } }),
  ) as { behavior: string; message?: string };
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message ?? "", /No approval came back/);
  assert.match(decision.message ?? "", /stop and report/i, "and tells the agent not to retry");
});

await shim.close();
await new Promise<void>((r) => server.close(() => r()));
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
