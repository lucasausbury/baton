import { randomBytes, randomUUID } from "node:crypto";
import express, { type Express, type Response } from "express";
import rateLimit from "express-rate-limit";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../db/index.ts";
import { escapeHtml, sameSecret, sha256 } from "../core/web.ts";
import { nowIso } from "../db/index.ts";

type Row = Record<string, unknown>;

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 120;
const PENDING_TTL_S = 15 * 60;
export const SCOPE = "baton";

const secret = (): string => randomBytes(32).toString("base64url");

const iso = (secondsFromNow: number): string =>
  new Date(Date.now() + secondsFromNow * 1000).toISOString();

const expired = (at: string | null): boolean =>
  at !== null && new Date(at).getTime() <= Date.now();

/**
 * Loopback redirects have to match without the port, because Claude Code binds
 * an ephemeral one per session (RFC 8252 section 7.3). Everything else must
 * match exactly.
 */
function redirectAllowed(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let got: URL;
  try {
    got = new URL(candidate);
  } catch {
    return false;
  }
  if (got.hostname !== "localhost" && got.hostname !== "127.0.0.1") return false;
  return registered.some((entry) => {
    try {
      const want = new URL(entry);
      return (
        want.protocol === got.protocol &&
        want.hostname === got.hostname &&
        want.pathname === got.pathname
      );
    } catch {
      return false;
    }
  });
}

export class OAuthProvider implements OAuthServerProvider {
  #db: Db;
  #password: string;
  #resource: string;
  #consentPath: string;

  constructor(opts: { db: Db; password: string; resource: string; consentPath: string }) {
    this.#db = opts.db;
    this.#password = opts.password;
    this.#resource = opts.resource;
    this.#consentPath = opts.consentPath;
  }

  // ---------------------------------------------------------------- clients

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.#db;
    return {
      getClient(clientId: string): OAuthClientInformationFull | undefined {
        const row = db
          .prepare(`SELECT metadata_json FROM oauth_clients WHERE client_id = ?`)
          .get(clientId) as Row | undefined;
        return row
          ? (JSON.parse(String(row.metadata_json)) as OAuthClientInformationFull)
          : undefined;
      },
      registerClient(
        client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
      ): OAuthClientInformationFull {
        // Dynamic registration is open by design: anyone may ask for a client
        // id, and it buys them nothing. The gate is the password on the consent
        // screen, which is what actually authorizes anything.
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        db.prepare(
          `INSERT INTO oauth_clients (client_id, metadata_json, created_at) VALUES (?, ?, ?)`,
        ).run(full.client_id, JSON.stringify(full), nowIso());
        return full;
      },
    };
  }

  // -------------------------------------------------------------- authorize

  /**
   * Shows the consent screen. The flow's parameters are written to the
   * database and the page carries only an opaque id, so nothing the browser
   * can edit decides where the code is sent.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO oauth_pending
           (id, client_id, redirect_uri, code_challenge, state, scopes_json,
            resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        params.state ?? null,
        JSON.stringify(params.scopes ?? [SCOPE]),
        params.resource?.href ?? null,
        iso(PENDING_TTL_S),
        nowIso(),
      );
    res.type("html").send(this.consentPage(id, client, params.redirectUri));
  }

  /** The consent screen. Deliberately plain, and usable on a phone. */
  consentPage(
    pendingId: string,
    client: OAuthClientInformationFull,
    redirectUri: string,
    error?: string,
  ): string {
    let host = redirectUri;
    try {
      host = new URL(redirectUri).host;
    } catch {
      /* show it raw if it will not parse */
    }
    const name = client.client_name ?? client.client_id;
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to baton</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#d8d8d8; --accent:#1a6ae0; --bad:#b4232c; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#eee; --bg:#141414; --muted:#9a9a9a; --line:#333; --accent:#5c9cff; --bad:#ff7b84; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         color:var(--fg); background:var(--bg); display:flex; justify-content:center; }
  main { width:100%; max-width:26rem; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  p { color:var(--muted); margin:.5rem 0; }
  .who { border:1px solid var(--line); border-radius:8px; padding:12px; margin:16px 0; }
  .who b { color:var(--fg); }
  label { display:block; margin:16px 0 6px; font-weight:600; }
  input { width:100%; padding:12px; font-size:16px; border:1px solid var(--line);
          border-radius:8px; background:var(--bg); color:var(--fg); }
  button { width:100%; margin-top:16px; padding:12px; font-size:16px; font-weight:600;
           border:0; border-radius:8px; background:var(--accent); color:#fff; }
  .err { color:var(--bad); font-weight:600; }
  .warn { font-size:.875rem; }
</style>
</head><body><main>
  <h1>Connect to baton</h1>
  <p><b>${escapeHtml(name)}</b> is asking for access.</p>
  <div class="who">
    You will be sent back to <b>${escapeHtml(host)}</b>
  </div>
  <p class="warn">This grants full control of every registered worker: creating
  tasks that run on your machines, and approving what they do. Only continue if
  you started this.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="${escapeHtml(this.#consentPath)}">
    <input type="hidden" name="request_id" value="${escapeHtml(pendingId)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit">Allow access</button>
  </form>
</main></body></html>`;
  }

  checkPassword(given: string): boolean {
    return sameSecret(given, this.#password);
  }

  pending(id: string): {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string | null;
    scopes: string[];
    resource: string | null;
  } | null {
    const row = this.#db.prepare(`SELECT * FROM oauth_pending WHERE id = ?`).get(id) as
      | Row
      | undefined;
    if (!row || expired(String(row.expires_at))) return null;
    return {
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      state: row.state === null ? null : String(row.state),
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      resource: row.resource === null ? null : String(row.resource),
    };
  }

  /** Consumes a proved authorization and returns the code to redirect with. */
  issueCode(pendingId: string): string | null {
    const p = this.pending(pendingId);
    if (!p) return null;
    const code = secret();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO oauth_codes
             (code_hash, client_id, redirect_uri, code_challenge, scopes_json,
              resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256(code),
          p.clientId,
          p.redirectUri,
          p.codeChallenge,
          JSON.stringify(p.scopes),
          p.resource,
          iso(CODE_TTL_S),
          nowIso(),
        );
      this.#db.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(pendingId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return code;
  }

  // ------------------------------------------------------------ code → token

  #code(code: string): Row | undefined {
    return this.#db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(sha256(code)) as
      | Row
      | undefined;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.#code(authorizationCode);
    if (!row || String(row.client_id) !== client.client_id) {
      throw new InvalidGrantError("invalid authorization code");
    }
    if (row.used_at !== null || expired(String(row.expires_at))) {
      throw new InvalidGrantError("authorization code is spent or expired");
    }
    return String(row.code_challenge);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // PKCE itself is checked by the SDK's token handler against the challenge
    // returned above; everything else about the code is checked here.
    const row = this.#code(authorizationCode);
    if (!row || String(row.client_id) !== client.client_id) {
      throw new InvalidGrantError("invalid authorization code");
    }
    if (row.used_at !== null) throw new InvalidGrantError("authorization code already used");
    if (expired(String(row.expires_at))) throw new InvalidGrantError("authorization code expired");
    if (redirectUri !== undefined && redirectUri !== String(row.redirect_uri)) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }

    this.#db
      .prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?`)
      .run(nowIso(), sha256(authorizationCode));

    const scopes = JSON.parse(String(row.scopes_json)) as string[];
    const bound = resource?.href ?? (row.resource === null ? this.#resource : String(row.resource));
    return this.#issueTokens(client.client_id, scopes, bound);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.#db
      .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`)
      .get(sha256(refreshToken)) as Row | undefined;

    // RFC 6749 wants invalid_grant specifically here, which is what the SDK's
    // token handler turns a thrown InvalidGrantError into. Claude retries on
    // the right code and gives up on the wrong one.
    if (!row || String(row.client_id) !== client.client_id) {
      throw new InvalidGrantError("unknown refresh token");
    }
    if (row.revoked_at !== null) throw new InvalidGrantError("refresh token was revoked");
    if (expired(row.expires_at === null ? null : String(row.expires_at))) {
      throw new InvalidGrantError("refresh token expired");
    }

    // Rotate: public clients must not reuse a refresh token, so this one dies
    // in the same breath as its replacement being issued.
    this.#db
      .prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`)
      .run(nowIso(), sha256(refreshToken));

    const granted = scopes ?? (JSON.parse(String(row.scopes_json)) as string[]);
    const bound = resource?.href ?? (row.resource === null ? this.#resource : String(row.resource));
    return this.#issueTokens(client.client_id, granted, bound);
  }

  #issueTokens(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = secret();
    const refresh = secret();
    const insert = this.#db.prepare(
      `INSERT INTO oauth_tokens
         (token_hash, kind, client_id, scopes_json, resource, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const scopesJson = JSON.stringify(scopes);
    insert.run(sha256(access), "access", clientId, scopesJson, resource, iso(ACCESS_TTL_S), nowIso());
    insert.run(
      sha256(refresh),
      "refresh",
      clientId,
      scopesJson,
      resource,
      iso(REFRESH_TTL_S),
      nowIso(),
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.#db
      .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`)
      .get(sha256(token)) as Row | undefined;
    if (!row) throw new InvalidTokenError("unknown access token");
    if (row.revoked_at !== null) throw new InvalidTokenError("access token was revoked");
    if (expired(row.expires_at === null ? null : String(row.expires_at))) {
      throw new InvalidTokenError("access token expired");
    }
    return {
      token,
      clientId: String(row.client_id),
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      expiresAt: row.expires_at === null
        ? undefined
        : Math.floor(new Date(String(row.expires_at)).getTime() / 1000),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.#db
      .prepare(
        `UPDATE oauth_tokens SET revoked_at = ?
          WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL`,
      )
      .run(nowIso(), sha256(request.token), client.client_id);
  }

  /** Drops spent and expired rows. Cheap, and keeps the file from creeping. */
  sweep(): void {
    const now = nowIso();
    this.#db.prepare(`DELETE FROM oauth_pending WHERE expires_at < ?`).run(now);
    this.#db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(now);
    this.#db
      .prepare(`DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(now);
  }
}

export interface OAuthApp {
  app: Express;
  provider: OAuthProvider;
  /** Paths this app owns, so the outer server knows what to hand over. */
  owns: (path: string) => boolean;
}

/**
 * Builds the OAuth surface: the SDK's router for metadata, registration,
 * authorize and token, plus our own consent POST.
 */
export function createOAuthApp(opts: {
  db: Db;
  password: string;
  publicUrl: string;
  mcpPath: string;
}): OAuthApp {
  const issuer = new URL(opts.publicUrl);
  const resource = new URL(opts.mcpPath, opts.publicUrl);
  const consentPath = "/oauth/consent";

  const provider = new OAuthProvider({
    db: opts.db,
    password: opts.password,
    resource: resource.href,
    consentPath,
  });

  const app = express();
  // Only Caddy sits in front, so trust exactly one hop when working out the
  // client address the rate limiter keys on.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // One password stands between a stranger and every machine behind this
  // server, so failed attempts are capped.
  const consentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many attempts. Wait a few minutes and try again.",
  });

  app.post(
    consentPath,
    consentLimiter,
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res) => {
      const body = req.body as Record<string, unknown>;
      const requestId = typeof body.request_id === "string" ? body.request_id : "";
      const password = typeof body.password === "string" ? body.password : "";

      const pending = provider.pending(requestId);
      if (!pending) {
        res
          .status(400)
          .type("html")
          .send(
            "<!doctype html><p>This sign-in request has expired. Start again from Claude.</p>",
          );
        return;
      }

      if (!provider.checkPassword(password)) {
        const client = provider.clientsStore.getClient(pending.clientId);
        res
          .status(401)
          .type("html")
          .send(
            provider.consentPage(
              requestId,
              (client as OAuthClientInformationFull | undefined) ?? {
                client_id: pending.clientId,
                redirect_uris: [pending.redirectUri],
              },
              pending.redirectUri,
              "That password is not right.",
            ),
          );
        return;
      }

      // Re-check the redirect against what the client registered, so a stale
      // pending row cannot send a code somewhere it was never allowed.
      const client = provider.clientsStore.getClient(pending.clientId) as
        | OAuthClientInformationFull
        | undefined;
      if (!client || !redirectAllowed(client.redirect_uris ?? [], pending.redirectUri)) {
        res.status(400).type("html").send("<!doctype html><p>Unknown redirect target.</p>");
        return;
      }

      const code = provider.issueCode(requestId);
      if (!code) {
        res.status(400).type("html").send("<!doctype html><p>This request has expired.</p>");
        return;
      }

      const target = new URL(pending.redirectUri);
      target.searchParams.set("code", code);
      if (pending.state !== null) target.searchParams.set("state", pending.state);
      res.redirect(302, target.href);
    },
  );

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: resource,
      resourceName: "baton",
      scopesSupported: [SCOPE],
    }),
  );

  const ownedPrefixes = [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/authorize",
    "/token",
    "/register",
    "/revoke",
    consentPath,
  ];

  return {
    app,
    provider,
    owns: (path: string) => ownedPrefixes.some((p) => path === p || path.startsWith(`${p}/`)),
  };
}

export { redirectAllowed };
