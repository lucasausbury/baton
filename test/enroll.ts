import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/core/store.ts";
import { buildServer } from "../src/server.ts";

const PASSWORD = "a-long-enough-test-password";

const dir = mkdtempSync(join(tmpdir(), "baton-enroll-"));
const db = openDb(join(dir, "enroll.db"));
const store = new Store(db);

const server = buildServer(store, db, { loginPassword: PASSWORD, host: "127.0.0.1" });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A server with no login password, to prove enrollment stays shut rather than
// falling through to the runner API.
const bare = buildServer(store, db, { adminToken: "x", host: "127.0.0.1" });
await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
const bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;

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

interface EnrollReply {
  workerId?: string;
  token?: string;
  error?: string;
  profileIds?: string[];
  projects?: string[];
}

const enroll = async (body: unknown, url = base): Promise<{ status: number; body: EnrollReply }> => {
  const res = await fetch(`${url}/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as EnrollReply };
};

await check("the wrong password enrolls nothing", async () => {
  const res = await enroll({ password: "nope", worker: { name: "Intruder" } });
  assert.equal(res.status, 401);
  assert.ok(!res.body.token, "and hands back no token");
  assert.throws(() => store.getWorker("intruder"), /no worker/i);
});

await check("a missing password is refused too", async () => {
  assert.equal((await enroll({ worker: { name: "Nameless" } })).status, 401);
});

await check("a nameless machine is refused", async () => {
  const res = await enroll({ password: PASSWORD, worker: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error ?? "", /name is required/i);
});

let token = "";

await check("enrolling returns a working token the operator never sees", async () => {
  const res = await enroll({
    password: PASSWORD,
    worker: { name: "Studio Mac", platform: "darwin" },
    profiles: [
      { label: "Personal", command: "claude", credentialRef: "personal" },
      { label: "Client A", command: "node", launchArgs: ["/opt/cli.js"], credentialRef: "client-a" },
    ],
    projects: [
      {
        name: "brochure",
        path: "/Users/you/src/brochure",
        profileLabel: "Client A",
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Bash(git status*)"],
        deniedTools: ["Bash(rm *)"],
      },
    ],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.workerId, "studio-mac");
  assert.match(res.body.token ?? "", /^baton_[0-9a-f]{32}$/);
  token = res.body.token ?? "";

  assert.deepEqual(res.body.projects, ["brochure"]);
  assert.equal(res.body.profileIds?.length, 2);
});

await check("that token is immediately good for the runner API", async () => {
  const res = await fetch(`${base}/v1/work?wait=0`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, "the machine can start working without another step");
});

await check("the profiles and permissions landed as asked", () => {
  const project = store.getProject("brochure");
  assert.equal(project.workerId, "studio-mac");
  assert.equal(project.defaultProfileId, "studio-mac:client-a");
  assert.equal(project.permissionMode, "acceptEdits");
  assert.deepEqual(project.allowedTools, ["Read", "Bash(git status*)"]);
  assert.deepEqual(project.deniedTools, ["Bash(rm *)"]);

  const profile = store.getProfile("studio-mac:client-a");
  assert.equal(profile.command, "node");
  assert.deepEqual(profile.launchArgs, ["/opt/cli.js"]);
  assert.equal(profile.credentialRef, "client-a");
});

await check("enrolling the same machine twice is refused, with a way forward", async () => {
  const res = await enroll({ password: PASSWORD, worker: { name: "Studio Mac" } });
  assert.equal(res.status, 409);
  assert.match(res.body.error ?? "", /already registered/i);
  assert.match(res.body.error ?? "", /replace/i, "it says what to do instead");
});

await check("replace rotates the token and retires the old one", async () => {
  const res = await enroll({
    password: PASSWORD,
    replace: true,
    worker: { name: "Studio Mac", platform: "darwin" },
  });
  assert.equal(res.status, 201);
  assert.notEqual(res.body.token, token, "a new token");

  const old = await fetch(`${base}/v1/work?wait=0`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(old.status, 401, "and the old one stops working");
});

await check("a bad permission mode is reported, not swallowed", async () => {
  const res = await enroll({
    password: PASSWORD,
    worker: { name: "Typo Box" },
    profiles: [{ label: "Personal", command: "claude" }],
    projects: [{ name: "typo", path: "/tmp/typo", permissionMode: "yolo" }],
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error ?? "", /unknown permission mode/i);
  assert.throws(() => store.getWorker("typo-box"), /no worker/i, "and nothing was created");
});

await check("without a login password enrollment is off, and says why", async () => {
  const res = await enroll({ password: PASSWORD, worker: { name: "Nope" } }, bareBase);
  assert.equal(res.status, 503);
  assert.match(res.body.error ?? "", /BATON_LOGIN_PASSWORD/);
});

await check("guessing the password is rate limited", async () => {
  let sawLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await enroll({ password: `guess-${i}`, worker: { name: "Guesser" } });
    if (res.status === 429) {
      sawLimit = true;
      break;
    }
    assert.equal(res.status, 401, "every wrong guess is a 401 until the limit bites");
  }
  assert.ok(sawLimit, "the attempts are capped");
});

await new Promise<void>((r) => server.close(() => r()));
await new Promise<void>((r) => bare.close(() => r()));
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
