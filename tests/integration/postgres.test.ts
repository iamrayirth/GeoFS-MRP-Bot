import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { sql } from 'drizzle-orm';
import { ALERT_COOLDOWN_MS } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { createRepos } from '../../src/db/repositories.js';

/**
 * Runs against a REAL PostgreSQL server over the production node-postgres pool (true multi-connection concurrency).
 * Skipped unless TEST_DATABASE_URL is set, e.g.  TEST_DATABASE_URL=postgres://geofs@127.0.0.1:54329/geofs npm test
 */
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('production driver against real PostgreSQL', () => {
  const handle = url ? createDb(url, { ssl: false, log: pino({ level: 'silent' }) }) : (null as never);
  const repos = () => createRepos(handle.db);

  beforeAll(async () => {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await handle.db.execute(sql`create schema public`);
  });
  afterAll(async () => { await handle.close(); });

  it('applies migrations, and re-applying is a no-op', async () => {
    await handle.migrate();
    await handle.migrate();
    const r = await handle.db.execute(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`);
    expect((r as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(6);
  });

  it('50 truly concurrent claims (separate connections) for one aircraft: exactly one wins', async () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const results = await Promise.all(Array.from({ length: 50 }, () => repos().cooldowns.tryClaim('RACE', 'c', 'IND', now, ALERT_COOLDOWN_MS)));
    expect(results.filter((x) => x.claimed)).toHaveLength(1);
    expect((await repos().cooldowns.get('RACE'))!.alertCount).toBe(1);
  });

  it('timestamps are stored as UTC instants', async () => {
    await repos().ignores.upsert('TZ', 'c', new Date('2026-06-01T00:00:00Z'), 'u');
    const [row] = await repos().ignores.listActive(new Date('2026-01-01T00:00:00Z'));
    expect(row!.expiresAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});
