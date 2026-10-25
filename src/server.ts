import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import type { Store } from "./core/store.ts";
import { createRunnerHandler, readJson, send } from "./http/server.ts";
import { createMcpHandler } from "./mcp/server.ts";

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One process serves both audiences: MCP at /mcp for the Claude apps, and a
 * plain REST surface for the runners. Same database, same state machine, so the
 * two can never disagree about what a session is doing.
 */
export function buildServer(store: Store, opts: { adminToken?: string; host?: string } = {}): Server {
  const adminToken = opts.adminToken ?? config.adminToken;
  const host = opts.host ?? config.httpHost;
  const runner = createRunnerHandler(store);
  const mcp = createMcpHandler(store);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.replace(/\/+$/, "") !== "/mcp") {
      runner(req, res);
      return;
    }

    void (async () => {
      try {
        const auth = req.headers.authorization ?? "";
        const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (adminToken) {
          if (!tokenMatches(given, adminToken)) {
            res.setHeader("www-authenticate", "Bearer");
            send(res, 401, { error: "invalid admin token" });
            return;
          }
        } else if (!LOOPBACK.has(host)) {
          send(res, 503, { error: "AWM_ADMIN_TOKEN must be set when not bound to loopback" });
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
