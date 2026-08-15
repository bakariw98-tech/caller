import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

let instance: DB | null = null;

export function getDb(): DB {
  if (instance) return instance;

  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  instance = db;
  return db;
}

export function applySchema(db: DB = getDb()): void {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(sql);
}

/** Test helper: an isolated in-memory database with the schema applied. */
export function createTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Money paths use this so a balance
 * read and the debit that follows it cannot interleave with another call.
 */
export function transact<T>(db: DB, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped.immediate();
}
