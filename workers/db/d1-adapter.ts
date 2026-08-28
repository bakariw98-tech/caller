import type { SqlDb, SqlStatement } from './types.js';

/** Wraps a D1Database binding to the shared SqlDb interface. */
export function wrapD1(d1: D1Database): SqlDb {
  return {
    prepare(sql: string): SqlStatement {
      const stmt = d1.prepare(sql);
      return {
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          const row = await stmt.bind(...params).first();
          return (row ?? undefined) as T | undefined;
        },
        async all<T>(...params: unknown[]): Promise<T[]> {
          const res = await stmt.bind(...params).all();
          return res.results as T[];
        },
        async run(...params: unknown[]) {
          const res = await stmt.bind(...params).run();
          return {
            changes: res.meta.changes ?? 0,
            lastInsertRowid: res.meta.last_row_id ?? null,
          };
        },
      };
    },
  };
}
