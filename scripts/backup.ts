import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";

/**
 * Takes an online backup of the database. SQLite's backup API copies a
 * consistent snapshot while the server keeps running, so this needs no
 * downtime and no lock dance.
 *
 * The whole system's state is one file, so this is the whole backup.
 */
const dir = process.env.BATON_BACKUP_DIR ?? "/data/backups";
const keep = Number(process.env.BATON_BACKUP_KEEP ?? 7);

mkdirSync(dir, { recursive: true });

// Millisecond resolution, so a manual run right after the nightly one cannot
// silently overwrite it. Colons are stripped to keep the name portable.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
const target = join(dir, `baton-${stamp}.db`);

const db = new DatabaseSync(config.dbPath, { readOnly: true });
try {
  const pages = await backup(db, target);
  console.log(`backed up ${pages} pages to ${target}`);
} finally {
  db.close();
}

// Keep the most recent `keep` backups and drop the rest.
const existing = readdirSync(dir)
  .filter((name) => /^baton-.*\.db$/.test(name))
  .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

for (const stale of existing.slice(keep)) {
  rmSync(join(dir, stale.name), { force: true });
  console.log(`removed ${stale.name}`);
}
