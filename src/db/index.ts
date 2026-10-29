import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";

export type Db = DatabaseSync;

/**
 * Opens the database and applies the schema. Safe to call repeatedly; the
 * schema is written so every statement is idempotent.
 *
 * node:sqlite is still flagged experimental, but the surface used here is just
 * exec/prepare/run/get/all -- if it ever breaks, swapping in better-sqlite3
 * means changing this file and nothing else.
 */
export function openDb(path: string = config.dbPath): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(readFileSync(join(import.meta.dirname, "schema.sql"), "utf8"));
  addMissingColumns(db);
  dropRetiredColumns(db);
  return db;
}

/**
 * Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS cannot
 * add a column to a table that already exists, so these are applied against the
 * live schema rather than tracked by a version number -- which keeps it honest
 * about a database of unknown age, and idempotent on one that is current.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "projects", column: "requested_posture", ddl: "TEXT" },
  { table: "workers", column: "inventory_json", ddl: "TEXT" },
  { table: "workers", column: "inventory_at", ddl: "TEXT" },
];

/**
 * Columns that must not exist any more.
 *
 * These held what a worker runs and where: a command, its launch arguments, its
 * environment, a project's path, and free-form tool patterns. All of it now
 * lives on the machine that runs the agent, because a server that can set those
 * can run anything anywhere. Dropping them is the migration -- leaving the data
 * behind would leave the thing we are removing.
 */
const DROPPED_COLUMNS: { table: string; column: string }[] = [
  { table: "profiles", column: "command" },
  { table: "profiles", column: "launch_args_json" },
  { table: "profiles", column: "args_json" },
  { table: "profiles", column: "env_json" },
  { table: "profiles", column: "credential_ref" },
  { table: "projects", column: "path" },
  { table: "projects", column: "permission_mode" },
  { table: "projects", column: "allowed_tools_json" },
  { table: "projects", column: "denied_tools_json" },
];

const columnsOf = (db: Db, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

function addMissingColumns(db: Db): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    if (columnsOf(db, table).includes(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Removes the columns above, and refuses to open the database if it cannot.
 *
 * Carrying on would mean serving requests out of a schema that still holds the
 * commands we no longer want the server able to choose. A clear failure at
 * startup is the right outcome: nothing is running yet, and the operator can
 * see exactly what to fix.
 */
function dropRetiredColumns(db: Db): void {
  for (const { table, column } of DROPPED_COLUMNS) {
    if (!columnsOf(db, table).includes(column)) continue;
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (err) {
      throw new Error(
        `cannot drop ${table}.${column} from this database: ` +
          `${err instanceof Error ? err.message : String(err)}. That column holds ` +
          `what a worker runs, which now belongs on the worker, so baton will not ` +
          `start while it is still here. Back the file up and remove the column by ` +
          `hand, or start from a fresh database and re-enrol your machines.`,
      );
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
