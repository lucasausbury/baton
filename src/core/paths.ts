import { homedir } from "node:os";
import { join } from "node:path";

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
