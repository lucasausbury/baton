import { resolve } from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

export const config = {
  /** SQLite file. The whole system's state lives here. */
  dbPath: resolve(process.env.AWM_DB ?? "data/awm.db"),

  /** Runner-facing HTTP API. */
  httpPort: num("AWM_PORT", 8787),
  httpHost: process.env.AWM_HOST ?? "0.0.0.0",

  /** How long a long-poll request is held open before returning empty. */
  longPollMs: num("AWM_LONG_POLL_MS", 25_000),
  /** How often a held request re-checks the database. */
  pollIntervalMs: num("AWM_POLL_INTERVAL_MS", 500),

  /**
   * How long the permission shim may hold an approval request open. Deliberately
   * generous: a parked agent costs nothing, and the whole point is that an
   * approval can wait until someone picks up the phone.
   */
  approvalWaitMs: num("AWM_APPROVAL_WAIT_MS", 6 * 60 * 60 * 1000),

  /** Treat a worker as offline once its last heartbeat is this old. */
  workerStaleMs: num("AWM_WORKER_STALE_MS", 90_000),

  /** Push notifications. Without a topic, notifications are logged only. */
  ntfyUrl: process.env.AWM_NTFY_URL ?? "https://ntfy.sh",
  ntfyTopic: process.env.AWM_NTFY_TOPIC ?? "",
  /** Re-notify about a session that is still blocked after this long. */
  blockedReminderMs: num("AWM_BLOCKED_REMINDER_MS", 20 * 60 * 1000),

  /** Shared secret for the MCP endpoint. Required unless bound to loopback. */
  adminToken: process.env.AWM_ADMIN_TOKEN ?? "",

  publicUrl: process.env.AWM_PUBLIC_URL ?? "",
} as const;
