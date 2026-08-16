/**
 * Async DB interface shared by the Node build (better-sqlite3, wrapped) and
 * this Workers build (D1, native).
 *
 * Shaped to match how the rest of the app already calls it —
 * `db.prepare(sql).get(...params)` / `.all(...params)` / `.run(...params)` —
 * so porting logic from src/ means adding `async`/`await`, not restructuring
 * every call site to a `.bind()` style.
 */
export interface SqlStatement {
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint | null }>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
}
