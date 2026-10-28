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
  return db;
}

/**
 * Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS cannot
 * add a column to a table that already exists, so these are applied against the
 * live schema rather than tracked by a version number -- which keeps it honest
 * about a database of unknown age, and idempotent on one that is current.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "projects", column: "permission_mode", ddl: "TEXT" },
  { table: "projects", column: "allowed_tools_json", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "projects", column: "denied_tools_json", ddl: "TEXT NOT NULL DEFAULT '[]'" },
];

function addMissingColumns(db: Db): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
