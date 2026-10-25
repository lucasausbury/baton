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
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
