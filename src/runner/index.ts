import { loadRunnerConfig } from "./config.ts";
import { ServerClient, ServerError } from "./client.ts";
import { runAgent, type RunningAgent } from "./agent.ts";

const IDLE_WAIT_MS = 25_000;
/** How often to check in while at capacity, to hear about cancellations. */
const BUSY_WAIT_MS = 5_000;

const config = loadRunnerConfig();
const client = new ServerClient(config.serverUrl, config.token);
const live = new Map<string, RunningAgent>();

let stopping = false;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[runner]", ...args);
}

async function tick(): Promise<void> {
  const free = Math.max(config.maxConcurrent - live.size, 0);
  const { work, cancelled } = await client.getWork(free > 0 ? IDLE_WAIT_MS : BUSY_WAIT_MS, free);

  for (const sessionId of cancelled) {
    const agent = live.get(sessionId);
    if (agent) {
      log(`cancelling ${sessionId}`);
      agent.kill();
    }
  }

  for (const item of work) {
    if (stopping) break;
    const { session, project, profile } = item;
    log(
      `starting ${session.id} (${project.name}, ${profile.label}${item.resume ? ", resume" : ""})`,
    );
    const agent = runAgent(item, client, config);
    live.set(session.id, agent);
    void agent.done.then(
      () => {
        live.delete(session.id);
        log(`finished ${session.id}`);
      },
      (err: unknown) => {
        live.delete(session.id);
        log(`errored ${session.id}:`, err);
      },
    );
  }

  if (free === 0 && work.length === 0 && cancelled.length === 0) {
    await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
  }
}

async function main(): Promise<void> {
  log(`worker ${config.workerId} -> ${config.serverUrl}, up to ${config.maxConcurrent} at once`);

  let backoff = config.retrySeconds;
  while (!stopping) {
    try {
      await tick();
      backoff = config.retrySeconds;
    } catch (err) {
      if (err instanceof ServerError && err.status === 401) {
        log("the server rejected this worker's token; fix runner.config.json and restart");
        process.exit(1);
      }
      // Anything else is almost always the network: a closed laptop lid, a
      // changed wifi, a server restart. Back off and keep trying.
      log(`check-in failed (${err instanceof Error ? err.message : String(err)}); retrying in ${backoff}s`);
      await new Promise((r) => setTimeout(r, backoff * 1000));
      backoff = Math.min(backoff * 2, 120);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal} - stopping ${live.size} agent(s)`);
  for (const agent of live.values()) agent.kill();
  await Promise.allSettled([...live.values()].map((a) => a.done));
  log("stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await main();
