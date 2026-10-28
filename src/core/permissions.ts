import type { PermissionMode } from "./types.ts";

/**
 * The permission postures the enrollment wizard offers per project.
 *
 * These are the three answers worth having to "what may this run without
 * asking me": nothing, edits but not commands, or everything except the
 * handful of things you cannot take back. They live here rather than in the
 * wizard so the docs, the CLI help and the wizard cannot drift apart.
 *
 * Everything listed in `allowedTools` is resolved by Claude Code itself, so it
 * never becomes an approval request and never reaches a phone.
 */
export interface PermissionPreset {
  key: string;
  label: string;
  detail: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  deniedTools: string[];
}

/** Reading and searching. Never changes anything, so it is safe everywhere. */
const INSPECTION = ["Read", "Glob", "Grep"];

/**
 * Commands that only report. `git diff *` and friends are matched by prefix, so
 * this does not quietly admit `git diff && rm -rf .` -- Claude Code matches the
 * whole command against the pattern.
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
 * pulling code off the internet to run. Denied even where everything else is
 * trusted, because the cost of being wrong does not scale with how much you
 * trust the agent.
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

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    key: "ask",
    label: "Ask me about everything",
    detail:
      "Every edit and every command waits for you. Safest, and by far the most " +
      "notifications -- a small task can be dozens of them.",
    permissionMode: "default",
    allowedTools: [],
    deniedTools: [],
  },
  {
    key: "edits",
    label: "Let it edit files, ask before commands",
    detail:
      "File changes go through, as do reading and searching and a few read-only " +
      "git and test commands. Anything else asks. A good default: you review the " +
      "diff anyway.",
    permissionMode: "acceptEdits",
    allowedTools: [...INSPECTION, ...SAFE_COMMANDS],
    deniedTools: [],
  },
  {
    key: "trusted",
    label: "Trust it, but block what cannot be undone",
    detail:
      "Runs unattended. Deleting, pushing, publishing, installing and fetching " +
      "from the network are still refused outright. For your own repos, not a " +
      "client's.",
    permissionMode: "bypassPermissions",
    allowedTools: [],
    deniedTools: IRREVERSIBLE,
  },
];

export const presetByKey = (key: string): PermissionPreset | undefined =>
  PERMISSION_PRESETS.find((p) => p.key === key);
