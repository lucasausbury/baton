import { config } from "./config.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./core/store.ts";
import { attachNotifications } from "./core/notify.ts";
import { buildServer, LOOPBACK } from "./server.ts";

const STALE_CLAIM_MS = 120_000;

const db = openDb();
const store = new Store(db);
attachNotifications(store);

const server = buildServer(store);

const reaper = setInterval(() => {
  try {
    const requeued = store.requeueStaleClaims(STALE_CLAIM_MS);
    if (requeued.length) console.log(`[reaper] requeued ${requeued.length} unstarted claim(s)`);
  } catch (err) {
    console.error("[reaper] failed:", err);
  }
}, 30_000);
reaper.unref();

server.listen(config.httpPort, config.httpHost, () => {
  console.log(`ai-worker-manager listening on ${config.httpHost}:${config.httpPort}`);
  console.log(`  db:       ${config.dbPath}`);
  console.log(`  runners:  /v1/work  (worker bearer token)`);
  console.log(`  mcp:      /mcp      (${config.adminToken ? "admin token set" : "NO ADMIN TOKEN"})`);
  console.log(`  notify:   ${config.ntfyTopic ? `ntfy ${config.ntfyTopic}` : "console only"}`);
  if (!config.adminToken && !LOOPBACK.has(config.httpHost)) {
    console.warn("  WARNING: /mcp is refusing requests until AWM_ADMIN_TOKEN is set.");
  }
});

function shutdown(signal: string): void {
  console.log(`\n${signal} - shutting down`);
  clearInterval(reaper);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Long-polls can be holding connections; do not wait on them forever.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
