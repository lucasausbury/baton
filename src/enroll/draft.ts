import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slug } from "../core/slug.ts";
import { POSTURES, type Posture } from "../core/types.ts";

/**
 * The wizard's working file.
 *
 * Enrolment is a dozen questions and then one request, and when that request
 * failed everything typed was gone. With half a dozen projects that is several
 * minutes of work lost to a server-side error, which is not a reasonable thing
 * to do to someone. So every answer is written here as it is given, and the
 * file is removed only once the machine is registered and its real config
 * written.
 *
 * It deliberately holds **no password and no token**. The password is asked for
 * again on resume -- it is the one thing cheap to retype and unacceptable to
 * leave on disk.
 */

export const DRAFT_VERSION = 1;

export interface DraftProfile {
  label: string;
  command: string;
  launchArgs: string[];
  args: string[];
  env: Record<string, string>;
  credentialRef: string | null;
  /** The CLAUDE_CONFIG_DIR this account uses, when it has one of its own. */
  configDir: string | null;
}

export interface DraftProject {
  name: string;
  path: string;
  profileLabel: string;
  posture: Posture;
  contained: boolean;
  allowedDomains: string[];
}

export interface Draft {
  version: number;
  serverUrl: string;
  machine: string;
  profiles: DraftProfile[];
  projects: DraftProject[];
  savedAt: string;
}

export const emptyDraft = (): Draft => ({
  version: DRAFT_VERSION,
  serverUrl: "",
  machine: "",
  profiles: [],
  projects: [],
  savedAt: "",
});

/** Beside the config it will eventually write, so the two travel together. */
export const draftPathFor = (configPath: string): string =>
  join(dirname(configPath), "runner.config.draft.json");

export function saveDraft(path: string, draft: Draft): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = { ...draft, version: DRAFT_VERSION, savedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

export function clearDraft(path: string): void {
  rmSync(path, { force: true });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Reads a draft back, or returns null.
 *
 * Anything unrecognised is null rather than an error: a draft is a convenience,
 * and refusing to run because an old one cannot be parsed would be a worse
 * failure than the one it is meant to prevent.
 */
export function loadDraft(path: string): Draft | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== DRAFT_VERSION) return null;

  const profiles: DraftProfile[] = (Array.isArray(raw.profiles) ? raw.profiles : [])
    .filter(isObject)
    .filter((p) => typeof p.label === "string" && typeof p.command === "string")
    .map((p) => ({
      label: p.label as string,
      command: p.command as string,
      launchArgs: strings(p.launchArgs),
      args: strings(p.args),
      env: isObject(p.env)
        ? Object.fromEntries(
            Object.entries(p.env).filter((e): e is [string, string] => typeof e[1] === "string"),
          )
        : {},
      credentialRef: typeof p.credentialRef === "string" ? p.credentialRef : null,
      configDir: typeof p.configDir === "string" ? p.configDir : null,
    }));

  const projects: DraftProject[] = (Array.isArray(raw.projects) ? raw.projects : [])
    .filter(isObject)
    .filter(
      (p) =>
        typeof p.name === "string" &&
        typeof p.path === "string" &&
        typeof p.posture === "string" &&
        POSTURES.includes(p.posture as Posture),
    )
    .map((p) => ({
      name: p.name as string,
      path: p.path as string,
      profileLabel: typeof p.profileLabel === "string" ? p.profileLabel : "",
      posture: p.posture as Posture,
      contained: p.contained === true,
      allowedDomains: strings(p.allowedDomains),
    }));

  return {
    version: DRAFT_VERSION,
    serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : "",
    machine: typeof raw.machine === "string" ? raw.machine : "",
    profiles,
    projects,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
  };
}

/**
 * Why a name cannot be used, or null if it can.
 *
 * The server stores a project under slug(name) as its primary key, so two names
 * that reduce to the same slug collide -- and that collision used to surface as
 * an opaque 500 at the very end, after every question had been answered. It is
 * caught here instead, on the keystroke that causes it.
 */
export function nameProblem(name: string, taken: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A name is needed.";

  let id: string;
  try {
    id = slug(trimmed);
  } catch {
    return "That has no letters or digits in it, so there is no id to make from it.";
  }

  for (const other of taken) {
    if (other === trimmed) return `You have already added "${trimmed}".`;
    // Compared by slug, because that is what the server uses as the id.
    if (slugOrNull(other) === id) {
      return `That becomes the id "${id}", which "${other}" already uses. Pick another name.`;
    }
  }
  return null;
}

const slugOrNull = (value: string): string | null => {
  try {
    return slug(value);
  } catch {
    return null;
  }
};
