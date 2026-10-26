import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { Store } from "./core/store.ts";
import { createRunnerHandler, readJson, send } from "./http/server.ts";
import { createMcpHandler } from "./mcp/server.ts";
import { createOAuthApp, type OAuthApp } from "./mcp/oauth.ts";

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const MCP_PATH = "/mcp";

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (req: IncomingMessage): string => {
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};

export interface BuildOptions {
  adminToken?: string;
  host?: string;
  publicUrl?: string;
  loginPassword?: string;
}

/**
 * One process serves both audiences: MCP at /mcp for the Claude apps, and a
 * plain REST surface for the runners. Same database, same state machine, so the
 * two can never disagree about what a session is doing.
 *
 * When a public URL and a password are configured, it is also its own OAuth
 * authorization server, because that is the only way the Claude mobile app can
 * authenticate to a custom connector: the static-header alternative is in beta
 * for a limited set of organizations, and the MCP authorization spec forbids
 * putting the token in the URL.
 */
export function buildServer(store: Store, db: Db, opts: BuildOptions = {}): Server {
  const adminToken = opts.adminToken ?? config.adminToken;
  const host = opts.host ?? config.httpHost;
  const publicUrl = opts.publicUrl ?? config.publicUrl;
  const loginPassword = opts.loginPassword ?? config.loginPassword;

  const runner = createRunnerHandler(store);
  const mcp = createMcpHandler(store);

  let oauth: OAuthApp | undefined;
  let resourceMetadataUrl = "";
  if (publicUrl && loginPassword) {
    oauth = createOAuthApp({ db, password: loginPassword, publicUrl, mcpPath: MCP_PATH });
    resourceMetadataUrl = new URL(
      `/.well-known/oauth-protected-resource${MCP_PATH}`,
      publicUrl,
    ).href;
    const sweeper = setInterval(() => {
      try {
        oauth?.provider.sweep();
      } catch (err) {
        console.error("[oauth] sweep failed:", err);
      }
    }, 10 * 60 * 1000);
    sweeper.unref();
  }

  /**
   * Decides whether a request may reach the MCP handler. The admin token is
   * kept alongside OAuth because Claude Code can send a static header today,
   * and there is no reason to break that in order to support the phone.
   */
  async function mcpAllowed(
    req: IncomingMessage,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string; challenge: boolean }> {
    const token = bearer(req);

    if (adminToken && token && tokenMatches(token, adminToken)) return { ok: true };

    if (oauth && token) {
      try {
        await oauth.provider.verifyAccessToken(token);
        return { ok: true };
      } catch {
        // Fall through: an expired or unknown token gets the same challenge as
        // no token at all, so Claude knows to refresh or sign in again.
      }
    }

    if (!adminToken && !oauth && !LOOPBACK.has(host)) {
      return {
        ok: false,
        status: 503,
        error: "set BATON_ADMIN_TOKEN, or BATON_PUBLIC_URL with a password, before exposing /mcp",
        challenge: false,
      };
    }

    if (!adminToken && !oauth) return { ok: true }; // loopback, no auth configured

    return {
      ok: false,
      status: 401,
      error: oauth ? "sign in to continue" : "invalid admin token",
      challenge: oauth !== undefined,
    };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // OAuth discovery, registration, authorize, token and the consent form.
    // Express owns these; everything else stays on the plain handler.
    if (oauth && oauth.owns(path)) {
      oauth.app(req, res);
      return;
    }

    if (path !== MCP_PATH) {
      runner(req, res);
      return;
    }

    void (async () => {
      try {
        const verdict = await mcpAllowed(req);
        if (!verdict.ok) {
          if (verdict.challenge) {
            // Claude only starts the OAuth flow from a 401 carrying this
            // pointer, and ignores the header on any other status.
            res.setHeader(
              "www-authenticate",
              `Bearer resource_metadata="${resourceMetadataUrl}"`,
            );
          } else if (verdict.status === 401) {
            res.setHeader("www-authenticate", "Bearer");
          }
          send(res, verdict.status, { error: verdict.error });
          return;
        }
        const body = req.method === "POST" ? await readJson(req) : undefined;
        await mcp(req, res, body);
      } catch (err) {
        console.error("[mcp] dispatch failed:", err);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      }
    })();
  });

  // Long-polling runners hold a request open, so never time them out.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 72_000;
  return server;
}
