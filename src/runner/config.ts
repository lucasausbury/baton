import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { POSTURES, type Posture } from "../core/types.ts";

/**
 * Everything sensitive about running an agent lives here, on the machine that
 * runs it -- never in the server's database.
 *
 * The server knows a project's name and a profile's label and nothing else. It
 * cannot say which binary to run, with what environment, in which directory,
 * or at what permission level above the ceiling set here. That is the point: it
 * means baton grants no power that sitting down at this machine and running
 * Claude Code would not, so a server that is taken over cannot reach past it.
 *
 * profiles and projects are keyed by slug(label) and slug(name), which is how
 * the server derives the ids it sends back.
 */

/** What a profile label actually runs on this machine. */
export interface LocalProfile {
  command: string;
  /** Inserted immediately after the command, before any of our own flags. */
  launchArgs: string[];
  /** Appended after our flags, for things like --model. */
  args: string[];
  env: Record<string, string>;
  /** Names an entry in `credentials`. */
  credentialRef: string | null;
}

/** What a project is, and the most its agents may ever do here. */
export interface LocalProject {
  path: string;
  /** Key into `profiles`. */
  profile: string;
  /** The ceiling. A session gets this or less, never more. */
  posture: Posture;
  /**
   * True to run shell commands inside the OS sandbox: writes confined to the
   * checkout, network egress refused except for allowedDomains. Unavailable on
   * native Windows, where a session that asks for it is refused rather than
   * quietly run uncontained.
   */
  contained: boolean;
  /** Hosts sandboxed commands may reach. Empty means none. */
  allowedDomains: string[];
}

export interface RunnerConfig {
  serverUrl: string;
  workerId: string;
  token: string;
  /** How many agents this machine will run at once. */
  maxConcurrent: number;
  /** credential_ref -> env vars to merge when spawning. */
  credentials: Record<string, Record<string, string>>;
  profiles: Record<string, LocalProfile>;
  projects: Record<string, LocalProject>;
  /** Seconds to wait before retrying after the server is unreachable. */
  retrySeconds: number;
  /** Where this was read from, for error messages worth reading. */
  source: string;
}

/**
 * Where to look, in order.
 *
 * The home directory comes before the working directory because the old
 * default put the file inside baton's own checkout -- which is a project an
 * agent may be working in, and an agent that can read it has the worker token
 * and every credential mapping on the machine. The deny rules refuse that path
 * as well, but the file simply not being there is better.
 */
export const CONFIG_CANDIDATES = [
  join(homedir(), ".baton", "runner.config.json"),
  resolve("runner.config.json"),
];

export const DEFAULT_CONFIG_PATH = CONFIG_CANDIDATES[0]!;

function fail(message: string): never {
  console.error(`[runner] ${message}`);
  process.exit(1);
}

function pickPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const found = CONFIG_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    fail(
      `no runner config found. Looked for:\n` +
        CONFIG_CANDIDATES.map((p) => `  ${p}`).join("\n") +
        `\n\nRun the wizard on this machine to create one:\n` +
        `  npm run enroll -- --server https://baton.example.com`,
    );
  }
  if (found === CONFIG_CANDIDATES[1]) {
    console.warn(
      `[runner] ${found} is inside a working directory. Move it to ` +
        `${DEFAULT_CONFIG_PATH} so no agent can reach it.`,
    );
  }
  return found;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function stringMap(value: unknown, where: string, file: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) fail(`${file}: "${where}" must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") fail(`${file}: ${where}.${k} must be a string`);
    out[k] = v;
  }
  return out;
}

function stringList(value: unknown, where: string, file: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${file}: "${where}" must be an array of strings`);
  for (const v of value) {
    if (typeof v !== "string") fail(`${file}: every entry in "${where}" must be a string`);
  }
  return value as string[];
}

export function loadRunnerConfig(path = process.env.BATON_RUNNER_CONFIG): RunnerConfig {
  const file = pickPath(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(raw)) fail(`${file} must contain a JSON object`);
  const o = raw;

  const need = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) fail(`${file} is missing "${key}"`);
    return v;
  };

  const credentials: Record<string, Record<string, string>> = {};
  if (o.credentials !== undefined) {
    if (!isObject(o.credentials)) fail(`${file}: "credentials" must be an object of ref -> env`);
    for (const [ref, env] of Object.entries(o.credentials)) {
      credentials[ref] = stringMap(env, `credentials.${ref}`, file);
    }
  }

  // A config written before profiles and projects moved onto the worker has
  // neither key. It cannot run anything, and guessing would mean inventing a
  // path and a permission level -- so say what happened and stop.
  if (o.profiles === undefined || o.projects === undefined) {
    fail(
      `${file} predates per-machine profiles and projects: it has no "profiles" ` +
        `or "projects" of its own, and the server no longer holds them. Re-run the ` +
        `wizard on this machine to rewrite it:\n` +
        `  npm run enroll -- --server ${typeof o.serverUrl === "string" ? o.serverUrl : "https://baton.example.com"} --replace`,
    );
  }

  const profiles: Record<string, LocalProfile> = {};
  if (!isObject(o.profiles)) fail(`${file}: "profiles" must be an object of label -> profile`);
  for (const [key, value] of Object.entries(o.profiles)) {
    if (!isObject(value)) fail(`${file}: profiles.${key} must be an object`);
    const command = value.command;
    if (typeof command !== "string" || command === "") {
      fail(`${file}: profiles.${key}.command is required`);
    }
    const credentialRef = value.credentialRef ?? null;
    if (credentialRef !== null && typeof credentialRef !== "string") {
      fail(`${file}: profiles.${key}.credentialRef must be a string or null`);
    }
    if (credentialRef !== null && !(credentialRef in credentials)) {
      fail(
        `${file}: profiles.${key} wants credential "${credentialRef}", which is not in ` +
          `"credentials". Naming a credential is the claim that this work belongs to one ` +
          `account; running it on whichever account happens to be signed in would be ` +
          `silent and wrong.`,
      );
    }
    profiles[key] = {
      command,
      launchArgs: stringList(value.launchArgs, `profiles.${key}.launchArgs`, file),
      args: stringList(value.args, `profiles.${key}.args`, file),
      env: stringMap(value.env, `profiles.${key}.env`, file),
      credentialRef,
    };
  }

  const projects: Record<string, LocalProject> = {};
  if (!isObject(o.projects)) fail(`${file}: "projects" must be an object of name -> project`);
  for (const [key, value] of Object.entries(o.projects)) {
    if (!isObject(value)) fail(`${file}: projects.${key} must be an object`);
    const projectPath = value.path;
    if (typeof projectPath !== "string" || !isAbsolute(projectPath)) {
      fail(`${file}: projects.${key}.path must be an absolute path`);
    }
    const profile = value.profile;
    if (typeof profile !== "string" || !(profile in profiles)) {
      fail(
        `${file}: projects.${key}.profile is ${JSON.stringify(profile)}, which is not one of ` +
          `the profiles defined here (${Object.keys(profiles).join(", ") || "none"})`,
      );
    }
    const posture = value.posture;
    if (typeof posture !== "string" || !POSTURES.includes(posture as Posture)) {
      fail(
        `${file}: projects.${key}.posture must be one of ${POSTURES.join(", ")}, ` +
          `got ${JSON.stringify(posture)}`,
      );
    }
    projects[key] = {
      path: projectPath,
      profile,
      posture: posture as Posture,
      contained: value.contained === true,
      allowedDomains: stringList(value.allowedDomains, `projects.${key}.allowedDomains`, file),
    };
  }

  return {
    serverUrl: need("serverUrl").replace(/\/$/, ""),
    workerId: need("workerId"),
    token: need("token"),
    maxConcurrent: typeof o.maxConcurrent === "number" ? o.maxConcurrent : 2,
    credentials,
    profiles,
    projects,
    retrySeconds: typeof o.retrySeconds === "number" ? o.retrySeconds : 5,
    source: file,
  };
}
