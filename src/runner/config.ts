import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runner configuration lives on the worker, not in the server's database.
 *
 * `credentials` is the reason: it maps a profile's `credential_ref` to the
 * environment that profile needs. The server stores only the reference, so no
 * secret ever leaves this machine.
 */
export interface RunnerConfig {
  serverUrl: string;
  workerId: string;
  token: string;
  /** How many agents this machine will run at once. */
  maxConcurrent: number;
  /** credential_ref -> env vars to merge when spawning. */
  credentials: Record<string, Record<string, string>>;
  /** Seconds to wait before retrying after the server is unreachable. */
  retrySeconds: number;
}

const DEFAULT_PATH = "runner.config.json";

function fail(message: string): never {
  console.error(`[runner] ${message}`);
  process.exit(1);
}

export function loadRunnerConfig(path = process.env.BATON_RUNNER_CONFIG ?? DEFAULT_PATH): RunnerConfig {
  const file = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(
      `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Create it with serverUrl, workerId and token, or point BATON_RUNNER_CONFIG at it.`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${file} must contain a JSON object`);
  }
  const o = raw as Record<string, unknown>;

  const need = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) fail(`${file} is missing "${key}"`);
    return v;
  };

  const credentials: Record<string, Record<string, string>> = {};
  const credsRaw = o.credentials;
  if (credsRaw !== undefined) {
    if (typeof credsRaw !== "object" || credsRaw === null || Array.isArray(credsRaw)) {
      fail(`${file}: "credentials" must be an object of ref -> env`);
    }
    for (const [ref, env] of Object.entries(credsRaw as Record<string, unknown>)) {
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        fail(`${file}: credentials.${ref} must be an object of env vars`);
      }
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v !== "string") fail(`${file}: credentials.${ref}.${k} must be a string`);
        mapped[k] = v;
      }
      credentials[ref] = mapped;
    }
  }

  return {
    serverUrl: need("serverUrl").replace(/\/$/, ""),
    workerId: need("workerId"),
    token: need("token"),
    maxConcurrent: typeof o.maxConcurrent === "number" ? o.maxConcurrent : 2,
    credentials,
    retrySeconds: typeof o.retrySeconds === "number" ? o.retrySeconds : 5,
  };
}
