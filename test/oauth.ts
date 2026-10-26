import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/core/store.ts";
import { buildServer } from "../src/server.ts";
import { redirectAllowed } from "../src/mcp/oauth.ts";

const ADMIN = "admin-token-for-tests";
const PASSWORD = "correct horse battery staple";
// Never dialled. The advertised origin has to be https, while the test talks to
// the loopback address directly.
const PUBLIC_URL = "https://awm.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const dir = mkdtempSync(join(tmpdir(), "awm-oauth-"));
const db = openDb(join(dir, "oauth.db"));
const store = new Store(db);

const server = buildServer(store, db, {
  adminToken: ADMIN,
  host: "127.0.0.1",
  publicUrl: PUBLIC_URL,
  loginPassword: PASSWORD,
});
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

const b64url = (b: Buffer): string => b.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

// -- discovery ---------------------------------------------------------------

await check("an unauthenticated /mcp answers 401 with a metadata pointer", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  // Claude starts sign-in only from a 401, and ignores the header on anything else.
  assert.equal(res.status, 401);
  const header = res.headers.get("www-authenticate") ?? "";
  assert.match(header, /^Bearer /);
  assert.match(
    header,
    /resource_metadata="https:\/\/awm\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});

await check("protected resource metadata names the server and its issuer", async () => {
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { resource: string; authorization_servers: string[] };
  // resource must equal the URL as entered in Claude, path included.
  assert.equal(body.resource, `${PUBLIC_URL}/mcp`);
  assert.deepEqual(body.authorization_servers, [`${PUBLIC_URL}/`]);
});

await check("authorization server metadata advertises what Claude requires", async () => {
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const md = (await res.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
    grant_types_supported?: string[];
  };
  assert.match(md.authorization_endpoint, /\/authorize$/);
  assert.match(md.token_endpoint, /\/token$/);
  assert.ok(md.registration_endpoint, "DCR must be advertised or Claude cannot register");
  assert.deepEqual(md.code_challenge_methods_supported, ["S256"]);
  assert.ok(md.grant_types_supported?.includes("refresh_token"), "refresh must be offered");
});

// -- registration ------------------------------------------------------------

let clientId = "";

await check("dynamic client registration issues a client id", async () => {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CALLBACK, "http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  // Read the body once: passing `await res.text()` as an assertion message
  // consumes it before res.json() can.
  const text = await res.text();
  assert.ok(res.status === 200 || res.status === 201, `register returned ${res.status}: ${text}`);
  const body = JSON.parse(text) as { client_id: string; client_secret?: string };
  assert.ok(body.client_id);
  assert.equal(body.client_secret, undefined, "Claude registers as a public client");
  clientId = body.client_id;
});

// -- the consent screen ------------------------------------------------------

const authorizeUrl = (extra: Record<string, string> = {}): string => {
  const u = new URL(`${base}/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "awm",
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
};

let requestId = "";

await check("/authorize shows a consent screen, not a redirect", async () => {
  const res = await fetch(authorizeUrl(), { redirect: "manual" });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Connect to ai-worker-manager/);
  // The spec wants the redirect target's hostname shown clearly.
  assert.match(html, /claude\.ai/);
  assert.match(html, /full control of every registered worker/, "and says what is at stake");
  const found = /name="request_id" value="([^"]+)"/.exec(html);
  assert.ok(found, "the page carries an opaque request id");
  requestId = found[1]!;
  assert.ok(!html.includes(challenge), "the PKCE challenge is not exposed to the browser");
  assert.ok(!html.includes(CALLBACK), "nor is the redirect URI an editable field");
});

await check("a wrong password is refused and does not consume the request", async () => {
  const res = await fetch(
    `${base}/oauth/consent`,
    { ...form({ request_id: requestId, password: "wrong" }), redirect: "manual" },
  );
  assert.equal(res.status, 401);
  assert.match(await res.text(), /not right/);
  // Still usable, so a typo does not mean starting over.
  assert.ok(db.prepare(`SELECT 1 FROM oauth_pending WHERE id = ?`).get(requestId));
});

let code = "";

await check("the right password redirects back with a code and the state", async () => {
  const res = await fetch(
    `${base}/oauth/consent`,
    { ...form({ request_id: requestId, password: PASSWORD }), redirect: "manual" },
  );
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
  assert.equal(location.searchParams.get("state"), "state-123", "state is returned verbatim");
  code = location.searchParams.get("code") ?? "";
  assert.ok(code);
  assert.equal(
    db.prepare(`SELECT 1 FROM oauth_pending WHERE id = ?`).get(requestId),
    undefined,
    "and the pending request is spent",
  );
});

// -- tokens ------------------------------------------------------------------

let accessToken = "";
let refreshToken = "";

await check("the code exchanges for tokens, with PKCE enforced", async () => {
  const bad = await fetch(
    `${base}/token`,
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: b64url(randomBytes(32)),
      client_id: clientId,
      redirect_uri: CALLBACK,
    }),
  );
  assert.equal(bad.status, 400, "a wrong verifier must not be accepted");

  const res = await fetch(
    `${base}/token`,
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    }),
  );
  const text = await res.text();
  assert.equal(res.status, 200, `token returned ${res.status}: ${text}`);
  const body = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.expires_in > 0);
  assert.ok(body.refresh_token, "a refresh token is required or the connection dies in an hour");
  accessToken = body.access_token;
  refreshToken = body.refresh_token;
});

await check("an authorization code cannot be replayed", async () => {
  const res = await fetch(
    `${base}/token`,
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    }),
  );
  assert.equal(res.status, 400);
});

await check("tokens are not stored in a usable form", () => {
  const rows = db.prepare(`SELECT token_hash FROM oauth_tokens`).all() as { token_hash: string }[];
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.notEqual(row.token_hash, accessToken);
    assert.notEqual(row.token_hash, refreshToken);
    assert.match(row.token_hash, /^[a-f0-9]{64}$/);
  }
});

// -- using it ----------------------------------------------------------------

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "oauth-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

await check("the access token works on /mcp", async () => {
  const client = await connect(accessToken);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("list_sessions"));
  await client.close();
});

await check("the admin token still works alongside OAuth", async () => {
  const client = await connect(ADMIN);
  assert.ok((await client.listTools()).tools.length > 0);
  await client.close();
});

await check("a made-up token is challenged, not accepted", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer not-a-real-token" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

// -- refresh -----------------------------------------------------------------

await check("refreshing issues new tokens and retires the old refresh token", async () => {
  const res = await fetch(
    `${base}/token`,
    form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  );
  const text = await res.text();
  assert.equal(res.status, 200, `refresh returned ${res.status}: ${text}`);
  const body = JSON.parse(text) as { access_token: string; refresh_token: string };
  assert.notEqual(body.access_token, accessToken, "a fresh access token");
  assert.ok(body.refresh_token);
  assert.notEqual(body.refresh_token, refreshToken, "rotated, as public clients require");

  const replay = await fetch(
    `${base}/token`,
    form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  );
  assert.equal(replay.status, 400);
  const err = (await replay.json()) as { error: string };
  // Claude distinguishes invalid_grant from other failures; the wrong code
  // leaves a connection wedged instead of prompting a new sign-in.
  assert.equal(err.error, "invalid_grant");

  accessToken = body.access_token;
  refreshToken = body.refresh_token;
});

await check("revoking an access token stops it working", async () => {
  const res = await fetch(
    `${base}/revoke`,
    form({ token: accessToken, client_id: clientId }),
  );
  assert.equal(res.status, 200, `revoke returned ${res.status}: ${await res.text()}`);
  const after = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: "{}",
  });
  assert.equal(after.status, 401);
});

// -- redirect matching -------------------------------------------------------

await check("loopback redirects match without the port, others match exactly", () => {
  const registered = [CALLBACK, "http://localhost/callback", "http://127.0.0.1/callback"];
  // Claude Code binds an ephemeral port per session (RFC 8252 section 7.3).
  assert.ok(redirectAllowed(registered, "http://localhost:3118/callback"));
  assert.ok(redirectAllowed(registered, "http://127.0.0.1:51234/callback"));
  assert.ok(redirectAllowed(registered, CALLBACK));
  // But nothing else gets that latitude.
  assert.ok(!redirectAllowed(registered, "https://evil.example.com/callback"));
  assert.ok(!redirectAllowed(registered, "http://localhost:3118/other"));
  assert.ok(!redirectAllowed(registered, "https://claude.ai/api/mcp/auth_callback/../evil"));
  assert.ok(!redirectAllowed(registered, "http://localhost.evil.com/callback"));
});

await check("a stale consent request is refused", async () => {
  db.prepare(
    `INSERT INTO oauth_pending (id, client_id, redirect_uri, code_challenge,
       state, scopes_json, resource, expires_at, created_at)
     VALUES ('stale', ?, ?, ?, NULL, '[]', NULL, ?, ?)`,
  ).run(clientId, CALLBACK, challenge, new Date(Date.now() - 1000).toISOString(), new Date().toISOString());
  const res = await fetch(
    `${base}/oauth/consent`,
    { ...form({ request_id: "stale", password: PASSWORD }), redirect: "manual" },
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /expired/);
});

await new Promise<void>((r) => server.close(() => r()));
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
