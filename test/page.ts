import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/core/store.ts";
import { buildServer } from "../src/server.ts";

const PASSWORD = "a-long-enough-test-password";
const XSS = '<script>alert("pwned")</script>';

const dir = mkdtempSync(join(tmpdir(), "baton-page-"));
const db = openDb(join(dir, "page.db"));
const store = new Store(db);

const { worker } = store.createWorker("MacBook Pro", "darwin");
const profile = store.createProfile({ workerId: worker.id, label: "opus-personal" });
store.registerProject({
  name: "alexandria",
  workerId: worker.id,
  defaultProfileId: profile.id,
});

const session = store.createSession({
  project: "alexandria",
  prompt: "Add a health endpoint.",
  title: "health endpoint",
});
store.claimWork(worker.id);
store.markStarted(session.id);
store.appendOutput(session.id, "Reading src/server.ts");
store.appendOutput(session.id, XSS);
store.ask({
  sessionId: session.id,
  kind: "approval_request",
  body: "Run `npm install express`?",
});

// A second session, left queued, to prove the page is per session.
const quiet = store.createSession({ project: "alexandria", prompt: "Later." });

const server = buildServer(store, db, { loginPassword: PASSWORD, host: "127.0.0.1" });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A server with no password at all, to prove the page stays off rather than
// falling through to the runner API and its misleading 401.
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

const get = (path: string, cookie?: string) =>
  fetch(`${base}${path}`, {
    redirect: "manual",
    headers: cookie === undefined ? {} : { cookie },
  });

const signIn = (path: string, password: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
  });

/** Mints a cookie the way the server does, so expiry can be tested directly. */
const cookieFor = (secondsFromNow: number): string => {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const sig = createHmac("sha256", PASSWORD).update(String(exp)).digest("hex");
  return `baton_page=${exp}.${sig}`;
};

await check("without a cookie the page asks for the password and shows nothing", async () => {
  const res = await get(`/s/${session.id}`);
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /Sign in/);
  assert.match(body, /type="password"/);
  assert.ok(!body.includes("alexandria"), "it does not leak the project");
  assert.ok(!body.includes("Reading src/server.ts"), "nor any output");
});

await check("the wrong password is refused", async () => {
  const res = await signIn(`/s/${session.id}`, "not-the-password");
  assert.equal(res.status, 401);
  assert.match(await res.text(), /not right/i);
});

await check("an empty password is refused", async () => {
  const res = await signIn(`/s/${session.id}`, "");
  assert.equal(res.status, 401);
});

let cookie = "";

await check("the right password sets a hardened cookie and redirects back", async () => {
  const res = await signIn(`/s/${session.id}`, PASSWORD);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/s/${session.id}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^baton_page=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/s/);
  assert.ok(!/Secure/.test(setCookie), "no Secure over plain http, or the cookie is unusable");
  cookie = (setCookie.split(";")[0] ?? "").trim();
});

await check("with the cookie the session renders", async () => {
  const res = await get(`/s/${session.id}`, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const body = await res.text();
  assert.match(body, /health endpoint/, "the title");
  assert.match(body, /alexandria/, "the project");
  assert.match(body, /opus-personal/, "the profile");
  assert.match(body, /blocked/, "the state");
  assert.match(body, /Reading src\/server\.ts/, "the output");
  assert.match(body, /Add a health endpoint\./, "the prompt");
});

await check("an open ask is called out, with where to answer it", async () => {
  const body = await (await get(`/s/${session.id}`, cookie)).text();
  assert.match(body, /Waiting on you/);
  assert.match(body, /npm install express/);
  assert.match(body, /cannot reply/i, "it says the page is not the way to answer");
});

await check("output is escaped, not rendered", async () => {
  const body = await (await get(`/s/${session.id}`, cookie)).text();
  assert.ok(!body.includes("<script>alert"), "the script tag is not live");
  assert.match(body, /&lt;script&gt;alert\(&quot;pwned&quot;\)/);
});

await check("a session with no output says so rather than looking broken", async () => {
  const body = await (await get(`/s/${quiet.id}`, cookie)).text();
  assert.equal(body.includes("Waiting on you"), false);
  assert.match(body, /queued/);
});

await check("an unknown session is a 404, but only once signed in", async () => {
  const signedIn = await get("/s/does-not-exist", cookie);
  assert.equal(signedIn.status, 404);
  const anonymous = await get("/s/does-not-exist");
  assert.equal(anonymous.status, 401, "an unsigned request cannot probe for ids");
});

await check("a tampered cookie is refused", async () => {
  const forged = `baton_page=${Math.floor(Date.now() / 1000) + 3600}.${"0".repeat(64)}`;
  assert.equal((await get(`/s/${session.id}`, forged)).status, 401);
});

await check("a malformed cookie is refused", async () => {
  for (const bad of ["baton_page=", "baton_page=nonsense", "baton_page=123", "baton_page=.abc"]) {
    assert.equal((await get(`/s/${session.id}`, bad)).status, 401, bad);
  }
});

await check("an expired cookie is refused even though it is signed", async () => {
  assert.equal((await get(`/s/${session.id}`, cookieFor(-60))).status, 401);
  assert.equal((await get(`/s/${session.id}`, cookieFor(3600))).status, 200, "but a live one works");
});

await check("the page is read-only: no other method is accepted", async () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${base}/s/${session.id}`, { method, redirect: "manual" });
    assert.ok(res.status === 404 || res.status === 405, `${method} -> ${res.status}`);
  }
});

await check("with no login password the page is off, and says why", async () => {
  const res = await fetch(`${bareBase}/s/${session.id}`, { redirect: "manual" });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /BATON_LOGIN_PASSWORD/);
});

await check("the runner API is untouched by the new route", async () => {
  assert.equal((await fetch(`${base}/v1/work`)).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

await new Promise<void>((r) => server.close(() => r()));
await new Promise<void>((r) => bare.close(() => r()));
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
