import { StateError } from "./types.ts";

/**
 * The one way an id is derived from a name.
 *
 * This lives apart from the store because the runner needs it too: a worker
 * looks up a project and a profile in its own config by the same key the
 * server derived, and importing the store would drag node:sqlite onto a
 * machine that has no database.
 */
export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!out) throw new StateError(`cannot derive an id from ${JSON.stringify(s)}`);
  return out;
}
