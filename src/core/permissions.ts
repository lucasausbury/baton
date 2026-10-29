import { POSTURES, type Posture } from "./types.ts";

/**
 * What an agent may do without asking, and the settings document that enforces
 * it.
 *
 * Two rules shape everything here.
 *
 * First, the server never names a tool pattern. It asks for a posture by name
 * and the worker decides what that means, because a compromised server that
 * could send `--allowedTools Bash` would have bought itself a shell. A posture
 * is an enum; there is nothing to inject.
 *
 * Second, nothing here uses `bypassPermissions`. That mode skips the protected
 * paths on `.git` and `.claude` and skips the read containment below, and the
 * Claude Code docs say to use it only in a container or a VM. A wide allow list
 * under `acceptEdits` is just as quiet and leaves every guard standing.
 */

/** The modes we are willing to pass. `bypassPermissions` is deliberately absent. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk";

export interface PermissionPreset {
  key: Posture;
  label: string;
  detail: string;
  permissionMode: PermissionMode;
  allow: string[];
  deny: string[];
}

/** Reading and searching. Never changes anything, so it is safe everywhere. */
const INSPECTION = ["Read", "Glob", "Grep"];

/**
 * Commands that only report. These are matched against the whole command, so
 * `Bash(git diff*)` does not quietly admit `git diff && rm -rf .`.
 */
const SAFE_COMMANDS = [
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git branch*)",
  "Bash(npm test*)",
  "Bash(npm run test*)",
  "Bash(npm run typecheck*)",
];

/**
 * The things that are hard or impossible to undo: publishing, deleting, and
 * pulling code off the internet to run. Denied in every posture, because the
 * cost of being wrong does not scale with how much you trust the agent.
 */
const IRREVERSIBLE = [
  "Bash(rm *)",
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(git clean*)",
  "Bash(npm publish*)",
  "Bash(npm install*)",
  "Bash(npx *)",
  "Bash(curl *)",
  "Bash(wget *)",
];

/**
 * Paths no session may read, whatever else it is allowed.
 *
 * `~/` is home-relative and `**` matches at any depth; a single leading slash
 * would anchor at the settings source instead of the filesystem root, which is
 * the easiest way to write a rule that silently matches nothing. On Windows
 * these are compared against POSIX-normalised paths, so `~/` still works.
 *
 * runner.config.json is on this list because baton's own checkout is a project
 * like any other: without the rule, an agent working on baton could read the
 * worker token and every credential mapping on the machine.
 */
const SENSITIVE_PATHS = [
  "~/.ssh/**",
  "~/.aws/**",
  "~/.gnupg/**",
  "~/.kube/**",
  "~/.config/gcloud/**",
  "~/.netrc",
  "~/.npmrc",
  "~/.git-credentials",
  // Claude Code's own state, including every account's login. An agent that
  // can edit these can re-permission itself.
  "~/.claude/**",
  "~/.claude.json",
  "~/.claude.json.backup*",
  "~/.claude-*/**",
  // baton's own secrets.
  "~/.baton/**",
  "**/runner.config.json",
  // The usual secrets inside a checkout.
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
];

/**
 * Deny rules for those paths.
 *
 * A `Read` deny also blocks Edit and Write on the same path, but not
 * NotebookEdit, so each path is listed under both tools. `Write(path)` and
 * `Glob(path)` rules are accepted by Claude Code and then never matched, so
 * they are not used here -- that is exactly the kind of rule that looks like
 * protection and is not.
 */
export const SENSITIVE_DENY_RULES: string[] = [
  ...SENSITIVE_PATHS.map((p) => `Read(${p})`),
  ...SENSITIVE_PATHS.map((p) => `Edit(${p})`),
];

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    key: "ask",
    label: "Ask me about everything",
    detail:
      "Every edit and every command waits for you. Safest, and by far the most " +
      "notifications -- a small task can be dozens of them.",
    permissionMode: "default",
    allow: [],
    deny: IRREVERSIBLE,
  },
  {
    key: "edits",
    label: "Let it edit files, ask before commands",
    detail:
      "File changes go through, as do reading and searching and a few read-only " +
      "git and test commands. Anything else asks. A good default: you review the " +
      "diff anyway.",
    permissionMode: "acceptEdits",
    allow: [...INSPECTION, ...SAFE_COMMANDS],
    deny: IRREVERSIBLE,
  },
  {
    key: "trusted",
    label: "Trust it, but block what cannot be undone",
    detail:
      "Edits and shell commands run unattended. Deleting, pushing, publishing, " +
      "installing and fetching from the network are still refused outright, and " +
      "so is reading anything secret. For your own repos, not a client's.",
    permissionMode: "acceptEdits",
    allow: [...INSPECTION, "Edit", "Write", "Bash"],
    deny: IRREVERSIBLE,
  },
];

export const presetFor = (posture: Posture): PermissionPreset => {
  const found = PERMISSION_PRESETS.find((p) => p.key === posture);
  // POSTURES and PERMISSION_PRESETS are both exhaustive over Posture, so this
  // is unreachable -- but falling back to the strictest posture is the right
  // way to be unreachable.
  return found ?? PERMISSION_PRESETS[0]!;
};

/**
 * The stricter of two postures.
 *
 * The server may ask for less autonomy than the machine allows, never more, so
 * a compromised server cannot raise a ceiling. POSTURES is ordered least to
 * most autonomous, so the lower index wins.
 */
export function stricter(a: Posture, b: Posture): Posture {
  return POSTURES.indexOf(a) <= POSTURES.indexOf(b) ? a : b;
}

export interface SettingsOptions {
  posture: Posture;
  /** True to put shell commands inside the OS sandbox. */
  contained: boolean;
  /** Hosts sandboxed commands may reach. Empty means none. */
  allowedDomains: string[];
}

/**
 * The settings document passed to one session with `--settings`.
 *
 * That flag sits above project, local and user settings in Claude Code's
 * precedence, so an agent cannot loosen any of this by writing a
 * `.claude/settings.json` into the repository it is working on. Only managed
 * settings outrank it, and those are the machine's own floor.
 */
export function sessionSettings(opts: SettingsOptions): Record<string, unknown> {
  const preset = presetFor(opts.posture);
  return {
    permissions: {
      allow: preset.allow,
      deny: [...preset.deny, ...SENSITIVE_DENY_RULES],
      // Reads outside the project are refused rather than offered. This is one
      // of the keys where the strict value from any scope wins.
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
    },
    sandbox: opts.contained
      ? {
          enabled: true,
          // Without this, a machine missing bubblewrap runs everything
          // unsandboxed and says nothing. Better to refuse to start.
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: opts.allowedDomains },
        }
      : { enabled: false },
  };
}
