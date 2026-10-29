import { SENSITIVE_DENY_RULES } from "./permissions.ts";

/**
 * The machine's floor: a managed-settings.json that no session can get under.
 *
 * Claude Code applies managed settings above everything else, including the
 * command line, and a deny rule at any level beats an allow rule at every
 * other. So this file is the one guard that holds even if baton itself is
 * wrong -- a bad posture, a bug in the settings we synthesise, or a server
 * that has been taken over and is sending whatever it likes.
 *
 * It lives in a system directory that needs administrator rights to write,
 * which is the point: the agent runs as you, so anything writable by you is
 * writable by it.
 */

export interface FloorTarget {
  /** Where the file has to end up. */
  path: string;
  /** How to put it there, given a file staged somewhere writable. */
  install: (staged: string) => string;
  /** True when writing it needs rights the wizard will not have. */
  needsElevation: boolean;
}

/**
 * Where managed settings live per platform.
 *
 * On WSL, `/etc/claude-code` is user-writable -- so an agent could rewrite its
 * own floor there. A WSL worker wants the Windows policy chain instead, via
 * `wslInheritsWindowsSettings` set from `C:\Program Files\ClaudeCode` or the
 * HKLM registry. floorTarget reports the Linux path for WSL and the caller
 * warns, because getting this wrong leaves a ceiling made of paper.
 */
export function floorTarget(platform: string = process.platform): FloorTarget {
  switch (platform) {
    case "win32":
      return {
        path: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
        install: (staged) =>
          `Copy-Item '${staged}' 'C:\\Program Files\\ClaudeCode\\managed-settings.json' -Force`,
        needsElevation: true,
      };
    case "darwin":
      return {
        path: "/Library/Application Support/ClaudeCode/managed-settings.json",
        install: (staged) =>
          `sudo install -d "/Library/Application Support/ClaudeCode" && ` +
          `sudo install -m 644 "${staged}" "/Library/Application Support/ClaudeCode/managed-settings.json"`,
        needsElevation: true,
      };
    default:
      return {
        path: "/etc/claude-code/managed-settings.json",
        install: (staged) =>
          `sudo install -d /etc/claude-code && ` +
          `sudo install -m 644 "${staged}" /etc/claude-code/managed-settings.json`,
        needsElevation: true,
      };
  }
}

/**
 * The floor itself.
 *
 * Deliberately short. Everything here is a refusal, because a managed allow
 * rule would be a hole that no lower scope could close -- and the per-session
 * settings are where permission is granted, not here.
 */
export function floorSettings(): Record<string, unknown> {
  return {
    permissions: {
      deny: SENSITIVE_DENY_RULES,
      // The mode that would skip every rule above. Locked out machine-wide, so
      // no session on this machine can be started in it -- not by baton, not by
      // hand, not by a server that has been taken over.
      disableBypassPermissionsMode: "disable",
      blockReadsOutsideWorkingDirectories: true,
    },
  };
}

export const floorJson = (): string => `${JSON.stringify(floorSettings(), null, 2)}\n`;
