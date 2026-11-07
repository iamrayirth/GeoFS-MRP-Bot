import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { schema } from './schema.js';
import type { Log } from '../logger.js';

/** Driver-agnostic handle: node-postgres in production, PGlite (real Postgres in WASM) in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_FOLDER = new URL('../../drizzle', import.meta.url).pathname;

export interface DbHandle {
  db: Db;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(url: string, opts: { ssl: boolean; log: Log }): DbHandle & { pool: pg.Pool; migrate(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
  });
  // A dropped idle client must not crash the process.
  pool.on('error', (err) => opts.log.error({ err: err.message }, 'postgres pool error'));
  const db = drizzle(pool, { schema });
  return {
    db: db as unknown as Db,
    pool,
    async ping() {
      try { await pool.query('select 1'); return true; } catch { return false; }
    },
    async migrate() { await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }); },
    async close() { await pool.end(); },
  };
}

/** Wait for the database to accept connections (container start-up ordering). */
export async function waitForDb(h: { ping(): Promise<boolean> }, log: Log, attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    if (await h.ping()) return;
    log.warn({ attempt: i, attempts }, 'waiting for database');
    await new Promise((r) => setTimeout(r, Math.min(5000, 500 * i)));
  }
  throw new Error('database not reachable');
}

export { sql };
