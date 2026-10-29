import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * A path as a person actually supplies it.
 *
 * Windows Explorer's "Copy as path" wraps the path in double quotes, and a
 * quoted string is not absolute -- so it used to be resolved against the
 * working directory, and the wizard then reported that a path you could see on
 * screen did not exist. Shells leave quotes behind the same way, and `~` is
 * expanded by a shell rather than by us, so a pasted one arrives literal.
 *
 * This lives apart from the wizard only so it can be tested: importing
 * src/enroll.ts runs it.
 */
export function cleanPath(input: string): string {
  let out = input.trim();
  if (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1).trim();
  }
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = join(homedir(), out.slice(1));
  }
  return out;
}

/**
 * Tab completion over directories, in readline's shape: the candidate
 * replacements for the whole line, and the line they were matched against.
 *
 * Only directories are offered, because every path the wizard asks for is one.
 * Each candidate keeps whichever separator was typed and ends with it, so
 * tabbing repeatedly walks down the tree the way a shell does.
 */
export function completeDir(line: string): [string[], string] {
  // cleanPath only strips a matched pair, which is right for a final answer: a
  // stray quote should stay visible rather than be quietly accepted. Mid-
  // keystroke it is the opposite -- a pasted path whose closing quote has not
  // been typed yet, or was just deleted, still wants completing. The candidates
  // come back unquoted, so tabbing also tidies the line.
  const typed = cleanPath(line).replace(/^['"]+/, "").replace(/['"]+$/, "");
  const cut = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\"));

  // Which separator to hand back: the one being used, else the platform's.
  const separator = cut >= 0 ? typed[cut]! : typed.includes("/") ? "/" : sep;
  const dir = cut < 0 ? "." : typed.slice(0, cut + 1);
  const prefix = typed.slice(cut + 1).toLowerCase();

  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        // A junction or symlink to a directory is still somewhere to go.
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
        return entry.name.toLowerCase().startsWith(prefix);
      })
      .map((entry) => entry.name);
  } catch {
    // An unreadable or half-typed directory is not an error worth reporting
    // mid-keystroke; it just means there is nothing to offer.
    return [[], line];
  }

  names.sort((a, b) => a.localeCompare(b));
  const head = cut < 0 ? "" : typed.slice(0, cut + 1);
  return [names.map((name) => `${head}${name}${separator}`), line];
}
