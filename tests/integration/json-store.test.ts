import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ALERT_COOLDOWN_MS } from '../../src/config.js';
import { JsonStore, StateCorruptError } from '../../src/store/json-store.js';
import { createRepos } from '../../src/store/repositories.js';
import { createTestStore, type TestStore } from '../helpers/store.js';

const log = pino({ level: 'silent' });
const at = (hhmm: string) => new Date(`2026-01-01T${hhmm}:00Z`);
let ts: TestStore;
afterEach(async () => { await ts?.cleanup(); });

const readState = async () => JSON.parse(await readFile(join(ts.dir, 'state.json'), 'utf8'));

describe('persistence', () => {
  it('everything survives a restart: config, cooldowns, ignores, tracking', async () => {
    ts = await createTestStore();
    let r = createRepos(ts.store);
    await r.identifiers.add('[USAF]', '[usaf]', 'u1');
    await r.countries.add('IND', 'India', 'u1');
    await r.settings.set('notification_channel_id', '123');
    await r.cooldowns.tryClaim('A1', 'Charlie[USAF]', 'IND', at('12:00'), ALERT_COOLDOWN_MS);
    await r.ignores.upsert('B2', 'Bravo', at('18:00'), 'u1');
    await r.tracking.upsertMany([{ aircraftId: 'A1', callsign: 'Charlie[USAF]', accountId: 7, aircraftTypeId: 4, matchedIdentifiers: ['[USAF]'], lat: 1, lon: 2, altitudeM: 3, speedKts: 4, headingDeg: 5, countryIso3: 'IND', firstSeenAt: at('11:00'), lastSeenAt: at('12:00'), active: true, lastAlertAt: at('12:00') }]);

    r = createRepos(await ts.reopen());
    expect((await r.identifiers.list()).map((x) => x.value)).toEqual(['[USAF]']);
    expect((await r.countries.list()).map((x) => x.iso3)).toEqual(['IND']);
    expect(await r.settings.get('notification_channel_id')).toBe('123');
    expect((await r.cooldowns.get('A1'))!.lastAlertAt).toEqual(at('12:00'));
    expect((await r.cooldowns.tryClaim('A1', 'c', 'IND', at('12:05'), ALERT_COOLDOWN_MS)).claimed).toBe(false); // still cooling down after restart
    expect((await r.ignores.listActive(at('12:00'))).map((x) => x.aircraftId)).toEqual(['B2']);
    expect(await r.tracking.get('A1')).toMatchObject({ countryIso3: 'IND', active: true, firstSeenAt: at('11:00') });
  });

  it('state.json is plain, human-readable JSON with UTC ISO timestamps and a schema version', async () => {
    ts = await createTestStore();
    await createRepos(ts.store).cooldowns.tryClaim('A1', 'c', 'IND', at('12:00'), ALERT_COOLDOWN_MS);
    const s = await readState();
    expect(s.version).toBe(1);
    expect(s.cooldowns.A1.lastAlertAt).toBe('2026-01-01T12:00:00.000Z');
    expect(await readdir(ts.dir)).not.toContain('state.json.tmp'); // temp file is always renamed away
  });

  it('a fresh directory starts empty', async () => {
    ts = await createTestStore();
    expect(ts.store.state).toMatchObject({ version: 1, identifiers: [], cooldowns: {}, ignores: {} });
  });

  it('non-durable (tracking) writes are debounced and flushed; close() flushes anything pending', async () => {
    ts = await createTestStore({ flushDelayMs: 30 });
    const r = createRepos(ts.store);
    const rec = (id: string) => ({ aircraftId: id, callsign: id, accountId: null, aircraftTypeId: null, matchedIdentifiers: [], lat: 1, lon: 2, altitudeM: null, speedKts: null, headingDeg: null, countryIso3: null, firstSeenAt: at('12:00'), lastSeenAt: at('12:00'), active: true, lastAlertAt: null });
    await r.tracking.upsertMany([rec('T1')]);
    await new Promise((res) => setTimeout(res, 150));
    expect(Object.keys((await readState()).tracking)).toEqual(['T1']);
    await r.tracking.upsertMany([rec('T2')]);
    await ts.store.close();
    expect(Object.keys((await readState()).tracking).sort()).toEqual(['T1', 'T2']);
  });

  it('many concurrent durable writes are serialised and the last state wins', async () => {
    ts = await createTestStore();
    const r = createRepos(ts.store);
    await Promise.all(Array.from({ length: 25 }, (_, i) => r.settings.set(`k${i}`, String(i))));
    const s = await readState();
    expect(Object.keys(s.settings)).toHaveLength(25);
  });
});

describe('crash safety and corruption', () => {
  it('a leftover half-written temp file from a crash is ignored', async () => {
    ts = await createTestStore();
    await createRepos(ts.store).settings.set('a', '1');
    await writeFile(join(ts.dir, 'state.json.tmp'), '{"version":1,"setti', 'utf8'); // crash mid-write
    const r = createRepos(await ts.reopen());
    expect(await r.settings.get('a')).toBe('1');
  });

  it('a corrupt state.json is restored from the backup and the damaged file is kept', async () => {
    ts = await createTestStore();
    const r = createRepos(ts.store);
    await r.settings.set('a', '1');
    await r.settings.set('b', '2'); // second write => .bak holds the state after the first
    await writeFile(join(ts.dir, 'state.json'), '{ not json', 'utf8');
    const r2 = createRepos(await ts.reopen());
    expect(await r2.settings.get('a')).toBe('1');
    expect((await readdir(ts.dir)).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('REFUSES to start (instead of silently resetting) when state.json is corrupt and there is no valid backup', async () => {
    ts = await createTestStore();
    await createRepos(ts.store).settings.set('a', '1');
    await ts.store.close();
    await writeFile(join(ts.dir, 'state.json'), 'garbage', 'utf8');
    await writeFile(join(ts.dir, 'state.json.bak'), 'also garbage', 'utf8');
    await expect(JsonStore.open(ts.dir, log, { lock: false })).rejects.toThrow(StateCorruptError);
    await expect(JsonStore.open(ts.dir, log, { lock: false })).rejects.toThrow(/Refusing to start/);
    // nothing was moved or deleted: the repeat attempt above sees the same files and refuses again (no silent reset)
    expect(await readFile(join(ts.dir, 'state.json'), 'utf8')).toBe('garbage');
    expect(await readFile(join(ts.dir, 'state.json.bak'), 'utf8')).toBe('also garbage');
    ts.store = await JsonStore.open(await mkdirTmp(), log, { lock: false }); // keep cleanup() happy
  });

  it('valid JSON of the wrong shape counts as corrupt', async () => {
    ts = await createTestStore();
    await ts.store.close();
    await writeFile(join(ts.dir, 'state.json'), JSON.stringify({ version: 1, cooldowns: { A: { lastAlertAt: 'not a date' } } }), 'utf8');
    await expect(JsonStore.open(ts.dir, log, { lock: false })).rejects.toThrow(/Refusing to start/);
    ts.store = await JsonStore.open(await mkdirTmp(), log, { lock: false });
  });

  it('a missing state.json whose backup is also unusable is NOT treated as a fresh install', async () => {
    ts = await createTestStore();
    await ts.store.close();
    await writeFile(join(ts.dir, 'state.json.bak'), '{ broken', 'utf8');
    await expect(JsonStore.open(ts.dir, log, { lock: false })).rejects.toThrow(/Refusing to start/);
    ts.store = await JsonStore.open(await mkdirTmp(), log, { lock: false });
  });

  it('a missing state.json with a valid backup is restored', async () => {
    ts = await createTestStore();
    const r = createRepos(ts.store);
    await r.settings.set('a', '1'); await r.settings.set('b', '2');
    await ts.store.close();
    const { rm } = await import('node:fs/promises');
    await rm(join(ts.dir, 'state.json'));
    const r2 = createRepos(await ts.reopen());
    expect(await r2.settings.get('a')).toBe('1');
  });
});

describe('disk failure handling', () => {
  it('a failed durable write reverts the in-memory change, so no phantom cooldown is left behind', async () => {
    ts = await createTestStore();
    const r = createRepos(ts.store);
    const real = (ts.store as any).writeAtomic.bind(ts.store);
    (ts.store as any).writeAtomic = async () => { throw new Error('ENOSPC'); };
    await expect(r.cooldowns.tryClaim('A1', 'c', 'IND', at('12:00'), ALERT_COOLDOWN_MS)).rejects.toThrow(/ENOSPC/);
    expect(await r.cooldowns.get('A1')).toBeNull();
    (ts.store as any).writeAtomic = real;
    expect((await r.cooldowns.tryClaim('A1', 'c', 'IND', at('12:01'), ALERT_COOLDOWN_MS)).claimed).toBe(true); // alert can still happen
  });

  it('config changes that cannot be saved are rolled back and reported', async () => {
    ts = await createTestStore();
    const r = createRepos(ts.store);
    (ts.store as any).writeAtomic = async () => { throw new Error('EIO'); };
    await expect(r.identifiers.add('[X]', '[x]', 'u')).rejects.toThrow(/EIO/);
    await expect(r.settings.set('k', 'v')).rejects.toThrow(/EIO/);
    expect(await r.identifiers.list()).toEqual([]);
    expect(await r.settings.get('k')).toBeNull();
  });

  it('health: becomes unhealthy after repeated write failures', async () => {
    ts = await createTestStore();
    const r = createRepos(ts.store);
    expect(await ts.store.ping()).toBe(true);
    (ts.store as any).writeAtomic = async () => { throw new Error('EIO'); };
    for (let i = 0; i < 3; i++) await r.settings.set('k', String(i)).catch(() => undefined);
    expect(await ts.store.ping()).toBe(false);
    expect(ts.store.lastWriteError).toMatch(/EIO/);
  });
});

async function mkdirTmp() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(join(tmpdir(), 'geofs-bot-test2-'));
}

describe('single-instance lock', () => {
  it('a second instance on the same directory is refused while the first is alive, and allowed after it closes', async () => {
    ts = await createTestStore({ lock: { staleMs: 30_000, heartbeatMs: 5_000, waitMs: 200 } });
    await expect(JsonStore.open(ts.dir, log, { lock: { staleMs: 30_000, heartbeatMs: 5_000, waitMs: 200 } })).rejects.toThrow(/in use by another bot instance/);
    await ts.store.close();
    const second = await JsonStore.open(ts.dir, log, { lock: { waitMs: 200 } });
    await second.close();
    ts.store = await JsonStore.open(await mkdirTmp(), log, { lock: false });
  });

  it('a crashed instance\'s stale lock is taken over', async () => {
    ts = await createTestStore();
    await mkdir(ts.dir, { recursive: true });
    await writeFile(join(ts.dir, 'state.lock'), JSON.stringify({ pid: 99999, host: 'gone', token: 'dead', heartbeatAt: new Date(Date.now() - 120_000).toISOString() }));
    const s = await JsonStore.open(ts.dir, log, { lock: { staleMs: 30_000, waitMs: 200 } });
    const lock = JSON.parse(await readFile(join(ts.dir, 'state.lock'), 'utf8'));
    expect(lock.pid).toBe(process.pid);
    await s.close();
    expect((await readdir(ts.dir)).includes('state.lock')).toBe(false); // released on clean shutdown
  });
});

describe('lock release on abnormal exit (real child process)', () => {
  it('process.exit(1) right after opening the store still removes state.lock', async () => {
    const { spawnSync } = await import('node:child_process');
    ts = await createTestStore();
    await ts.store.close();
    const script = `
      import pino from 'pino';
      import { JsonStore } from ${JSON.stringify(new URL('../../src/store/json-store.ts', import.meta.url).pathname)};
      await JsonStore.open(${JSON.stringify(ts.dir)}, pino({ level: 'silent' }));
      process.exit(1); // simulates a fatal startup error after the store was opened
    `;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect((await readdir(ts.dir)).includes('state.lock')).toBe(false);
    ts.store = await JsonStore.open(ts.dir, log, { lock: { waitMs: 100 } }); // would have waited/failed on a leftover lock
  });
});
