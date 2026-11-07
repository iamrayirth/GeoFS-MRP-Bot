import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, type Repos } from '../../src/db/repositories.js';
import { ALERT_COOLDOWN_MS } from '../../src/config.js';
import { createTestDb } from '../helpers/db.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let r: Repos;
beforeEach(async () => { db = await createTestDb(); r = createRepos(db.db); });
afterEach(async () => { await db.close(); });
const at = (hhmmss: string) => new Date(`2026-01-01T${hhmmss}Z`);

describe('cooldown claims (atomic)', () => {
  it('20 simultaneous claims for one aircraft: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => r.cooldowns.tryClaim('X1', 'Cs[USAF]', 'IND', at('12:00:00'), ALERT_COOLDOWN_MS)));
    expect(results.filter((x) => x.claimed)).toHaveLength(1);
    expect((await r.cooldowns.get('X1'))!.alertCount).toBe(1);
  });

  it('boundary: refused at 9:59, granted at exactly 10:00', async () => {
    expect((await r.cooldowns.tryClaim('X1', 'c', 'IND', at('12:00:00'), ALERT_COOLDOWN_MS)).claimed).toBe(true);
    expect((await r.cooldowns.tryClaim('X1', 'c', 'IND', at('12:09:59'), ALERT_COOLDOWN_MS)).claimed).toBe(false);
    expect((await r.cooldowns.tryClaim('X1', 'c', 'NPL', at('12:10:00'), ALERT_COOLDOWN_MS)).claimed).toBe(true);
    const row = (await r.cooldowns.get('X1'))!;
    expect(row.alertCount).toBe(2);
    expect(row.lastCountryIso3).toBe('NPL');
  });

  it('different aircraft ids never block each other', async () => {
    expect((await r.cooldowns.tryClaim('A', 'same', 'IND', at('12:00:00'), ALERT_COOLDOWN_MS)).claimed).toBe(true);
    expect((await r.cooldowns.tryClaim('B', 'same', 'IND', at('12:00:00'), ALERT_COOLDOWN_MS)).claimed).toBe(true);
  });

  it('release restores state (and only if the claim is still the latest)', async () => {
    const c1 = await r.cooldowns.tryClaim('A', 'c', 'IND', at('12:00:00'), ALERT_COOLDOWN_MS);
    await r.cooldowns.release('A', at('12:00:00'), c1.previous);
    expect(await r.cooldowns.get('A')).toBeNull();
    await r.cooldowns.tryClaim('A', 'c', 'IND', at('12:00:00'), ALERT_COOLDOWN_MS);
    await r.cooldowns.release('A', at('11:00:00'), null); // stale claim timestamp: must not delete the newer claim
    expect(await r.cooldowns.get('A')).not.toBeNull();
  });

  it('loadActive returns only rows still inside the window; prune removes old ones', async () => {
    await r.cooldowns.tryClaim('old', 'c', null, at('10:00:00'), ALERT_COOLDOWN_MS);
    await r.cooldowns.tryClaim('new', 'c', null, at('12:05:00'), ALERT_COOLDOWN_MS);
    expect((await r.cooldowns.loadActive(at('12:10:00'), ALERT_COOLDOWN_MS)).map((x) => x.aircraftId)).toEqual(['new']);
    expect(await r.cooldowns.prune(at('11:00:00'))).toBe(1);
  });
});

describe('ignored aircraft', () => {
  it('lists only unexpired ignores, ordered by expiry, and shows the stored callsign', async () => {
    await r.ignores.upsert('A', 'Alpha', at('12:30:00'), 'u1');
    await r.ignores.upsert('B', 'Bravo', at('12:10:00'), 'u1');
    await r.ignores.upsert('C', 'Charlie', at('11:00:00'), 'u1');
    const list = await r.ignores.listActive(at('12:00:00'));
    expect(list.map((x) => [x.aircraftId, x.callsign])).toEqual([['B', 'Bravo'], ['A', 'Alpha']]);
    expect((await r.ignores.listActive(at('12:10:00'))).map((x) => x.aircraftId)).toEqual(['A']); // expiry instant is exclusive
  });
  it('re-ignoring extends/replaces; remove reports whether something was removed', async () => {
    await r.ignores.upsert('A', 'Alpha', at('12:10:00'), 'u1');
    await r.ignores.upsert('A', 'Alpha', at('14:00:00'), 'u2');
    expect((await r.ignores.listActive(at('12:00:00')))[0]!.expiresAt).toEqual(at('14:00:00'));
    expect(await r.ignores.remove('A')).toBe(true);
    expect(await r.ignores.remove('A')).toBe(false);
  });
});

describe('configuration persistence', () => {
  it('identifiers are unique case-insensitively', async () => {
    expect(await r.identifiers.add('[USAF]', '[usaf]', 'u')).toBe(true);
    expect(await r.identifiers.add('[usaf]', '[usaf]', 'u')).toBe(false);
    expect((await r.identifiers.list()).map((x) => x.value)).toEqual(['[USAF]']);
    expect(await r.identifiers.remove('[usaf]')).toBe(true);
    expect(await r.identifiers.remove('[usaf]')).toBe(false);
  });
  it('countries, channel and role round-trip', async () => {
    expect(await r.countries.add('IND', 'India', 'u')).toBe(true);
    expect(await r.countries.add('IND', 'India', 'u')).toBe(false);
    await r.settings.set('notification_channel_id', '123');
    await r.settings.set('notification_channel_id', '456');
    expect(await r.settings.get('notification_channel_id')).toBe('456');
    expect((await r.countries.list()).map((c) => c.iso3)).toEqual(['IND']);
    expect(await r.countries.remove('IND')).toBe(true);
  });
});
