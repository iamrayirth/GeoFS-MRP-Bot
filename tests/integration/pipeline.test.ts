import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, obs, PLACE, t, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

const A = (over: Record<string, unknown> = {}) => obs({ id: '1001', callsign: 'Charlie[USAF]', ...PLACE.delhi, ...over });
const stamps = (hh: Harness) => hh.notifier.sent.map((p) => p.detectedAt.toISOString().slice(11, 16));

describe('global 10-minute cooldown (the specified timeline)', () => {
  beforeEach(async () => { h = await createHarness(); });

  it('12:00 India ALERT · 12:03 Pakistan · 12:08 Nepal · 12:10 Nepal ALERT · 12:20 Nepal ALERT', async () => {
    expect((await h.tick([A(PLACE.delhi)], t('12:00'))).sent).toBe(1);
    expect((await h.tick([A(PLACE.lahore)], t('12:03'))).sent).toBe(0);
    expect((await h.tick([A(PLACE.kathmandu)], t('12:08'))).sent).toBe(0);
    expect((await h.tick([A(PLACE.kathmandu)], t('12:10'))).sent).toBe(1);
    expect((await h.tick([A(PLACE.kathmandu)], t('12:20'))).sent).toBe(1);
    expect(stamps(h)).toEqual(['12:00', '12:10', '12:20']);
    expect(h.notifier.sent.map((p) => p.country.iso3)).toEqual(['IND', 'NPL', 'NPL']);
    expect(h.notifier.sent.map((p) => p.kind)).toEqual(['entered', 'remains', 'remains']);
  });

  it('cooldown is shared across countries: country changes do not reset it', async () => {
    await h.tick([A(PLACE.delhi)], t('12:00'));
    for (const [place, at] of [[PLACE.lahore, '12:01'], [PLACE.kathmandu, '12:02'], [PLACE.delhi, '12:05'], [PLACE.lahore, '12:09']] as const) {
      expect((await h.tick([A(place)], t(at))).sent).toBe(0);
    }
    expect((await h.tick([A(PLACE.lahore)], t('12:10'))).sent).toBe(1);
  });

  it('after expiry: outside monitored countries -> no alert; entering later -> immediate alert', async () => {
    await h.tick([A(PLACE.delhi)], t('12:00'));
    expect((await h.tick([A(PLACE.paris)], t('12:11'))).sent).toBe(0); // cooldown over, but in France
    expect((await h.tick([A(PLACE.midAtlantic)], t('12:12'))).sent).toBe(0);
    const r = await h.tick([A(PLACE.kathmandu)], t('12:13'));
    expect(r.sent).toBe(1);
    expect(h.notifier.sent.at(-1)!.kind).toBe('entered');
  });

  it('the role is pinged on every alert, repeats included, and only the configured channel is targeted', async () => {
    await h.tick([A(PLACE.delhi)], t('12:00'));
    await h.tick([A(PLACE.delhi)], t('12:10'));
    expect(h.notifier.sent).toHaveLength(2);
    for (const p of h.notifier.sent) { expect(p.roleId).toBe('222222222222222222'); expect(p.channelId).toBe('111111111111111111'); }
  });
});

describe('persistence across restarts', () => {
  beforeEach(async () => { h = await createHarness(); });

  it('a restart inside the cooldown causes no duplicate (warm cache)', async () => {
    await h.tick([A()], t('12:00'));
    await h.restart({ warm: true });
    expect((await h.tick([A()], t('12:04'))).sent).toBe(0);
    expect((await h.tick([A()], t('12:10'))).sent).toBe(1);
  });

  it('even a cold restart (no cache warm-up) cannot duplicate: the persisted claim refuses', async () => {
    await h.tick([A()], t('12:00'));
    await h.restart({ warm: false });
    expect((await h.tick([A()], t('12:04'))).sent).toBe(0);
    expect((await h.tick([A()], t('12:10'))).sent).toBe(1);
  });

  it('cooldown state is retained after the aircraft disappears', async () => {
    await h.tick([A()], t('12:00'));
    await h.tick([], t('12:02')); // gone
    expect((await h.repos.cooldowns.get('1001'))?.lastAlertAt.toISOString()).toBe(t('12:00').toISOString());
    expect((await h.tick([A()], t('12:05'))).sent).toBe(0); // same id returns inside the window
  });

  it('two managers racing on one aircraft (shared state) produce exactly one alert', async () => {
    const { AlertManager } = await import('../../src/alerts/alert-manager.js');
    const { AircraftTracker } = await import('../../src/tracking/tracker.js');
    const { geo, log, snapshot } = await import('../helpers/harness.js');
    const at = t('12:00');
    const mk = () => ({
      tracker: new AircraftTracker(geo(), h.names, { staleAfterMs: 120_000 }),
      manager: new AlertManager({ repos: h.repos, config: h.config, notifier: h.notifier, log, now: () => at }),
    });
    const p1 = mk(); const p2 = mk(); // two managers sharing one store
    const r1 = p1.tracker.ingest(snapshot([A()], at), h.config.identifiers, at);
    const r2 = p2.tracker.ingest(snapshot([A()], at), h.config.identifiers, at);
    await Promise.all([p1.manager.processCycle(r1.active), p2.manager.processCycle(r2.active)]);
    expect(h.notifier.sent).toHaveLength(1);
  });
});

describe('identifiers', () => {
  it('removing an identifier immediately stops alerts for aircraft that only match it', async () => {
    h = await createHarness({ identifiers: ['[USAF]', '[RAF]'] });
    const a = A(); const b = obs({ id: '1002', callsign: '[RAF]Delta', ...PLACE.delhi });
    expect((await h.tick([a, b], t('12:00'))).sent).toBe(2);
    await h.config.removeIdentifier('[usaf]');
    const r = await h.tick([a, b], t('12:10'));
    expect(r.sent).toBe(1);
    expect(h.notifier.sent.at(-1)!.aircraftId).toBe('1002');
  });

  it('an aircraft matching several identifiers alerts once and lists them all', async () => {
    h = await createHarness({ identifiers: ['[USAF]', '[RAF]'] });
    await h.tick([obs({ id: '5', callsign: '[RAF]Pilot[usaf]' })], t('12:00'));
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]!.matchedIdentifiers.sort()).toEqual(['[RAF]', '[USAF]']);
  });

  it('non-matching callsigns never alert', async () => {
    h = await createHarness();
    expect((await h.tick([obs({ id: '9', callsign: 'Foo' }), obs({ id: '10', callsign: 'Qantas1' })], t('12:00'))).sent).toBe(0);
  });
});

describe('multiple aircraft and identity', () => {
  beforeEach(async () => { h = await createHarness(); });

  it('identical callsigns with different multiplayer ids are independent aircraft with independent cooldowns', async () => {
    const a = A({ id: 'A1' }); const b = A({ id: 'B2' });
    expect((await h.tick([a, b], t('12:00'))).sent).toBe(2);
    expect((await h.tick([a, b], t('12:05'))).sent).toBe(0);
    expect(new Set(h.notifier.sent.map((p) => p.aircraftId))).toEqual(new Set(['A1', 'B2']));
  });

  it('a reconnect with a NEW multiplayer id is a new aircraft (alerts immediately despite old cooldown)', async () => {
    await h.tick([A({ id: 'OLD' })], t('12:00'));
    await h.tick([], t('12:01'));
    const r = await h.tick([A({ id: 'NEW' })], t('12:02'));
    expect(r.sent).toBe(1);
    expect(h.notifier.sent.at(-1)!.aircraftId).toBe('NEW');
  });

  it('disappearing aircraft are marked inactive and no longer processed', async () => {
    await h.tick([A()], t('12:00'));
    expect(h.tracker.get('1001')!.active).toBe(true);
    await h.tick([], t('12:02'));
    expect(h.tracker.get('1001')!.active).toBe(false);
    expect(h.tracker.activeCount).toBe(0);
    expect((await h.repos.tracking.get('1001'))!.active).toBe(false);
  });

  it('stale server records are not processed', async () => {
    const now = t('12:00');
    const stale = A({ serverTimeMs: now.getTime() - 3_600_000 });
    expect((await h.tick([stale], now)).sent).toBe(0);
    expect(h.tracker.get('1001')).toBeUndefined();
    const fresh = A({ serverTimeMs: now.getTime() - 2_000 });
    expect((await h.tick([fresh], t('12:00:10'))).sent).toBe(1);
  });

  it('tracks everything it is told about (all fields), and persists matching aircraft', async () => {
    await h.tick([A(), obs({ id: '77', callsign: 'Nobody' })], t('12:00'));
    const tr = h.tracker.get('1001')!;
    expect(tr).toMatchObject({ callsign: 'Charlie[USAF]', matchedIdentifiers: ['[USAF]'], aircraftTypeLabel: 'Boeing 737-700', speedKts: 420, headingDeg: 270, lastAlertAt: t('12:00') });
    expect(tr.geo.countries[0]!.iso3).toBe('IND');
    expect(h.tracker.get('77')!.matchedIdentifiers).toEqual([]);
    const row = await h.repos.tracking.get('1001');
    expect(row).toMatchObject({ countryIso3: 'IND', matchedIdentifiers: ['[USAF]'], active: true });
    expect(await h.repos.tracking.get('77')).toBeNull(); // only matching aircraft are persisted
  });
});

describe('temporary ignore', () => {
  beforeEach(async () => { h = await createHarness(); });

  it('ignored aircraft never alert; alerts resume when the ignore expires', async () => {
    await h.repos.ignores.upsert('1001', 'Charlie[USAF]', t('12:30'), 'admin');
    expect((await h.tick([A()], t('12:00'))).sent).toBe(0);
    expect((await h.tick([A()], t('12:29'))).sent).toBe(0);
    expect((await h.tick([A()], t('12:30'))).sent).toBe(1);
  });

  it('manual unignore takes effect immediately', async () => {
    await h.repos.ignores.upsert('1001', 'Charlie[USAF]', t('13:00'), 'admin');
    expect((await h.tick([A()], t('12:00'))).sent).toBe(0);
    expect(await h.repos.ignores.remove('1001')).toBe(true);
    expect((await h.tick([A()], t('12:01'))).sent).toBe(1);
  });

  it('the ignore is bound to the multiplayer id: a reconnect under a new id is NOT ignored', async () => {
    await h.repos.ignores.upsert('OLD', 'Charlie[USAF]', t('18:00'), 'admin');
    expect((await h.tick([A({ id: 'OLD' })], t('12:00'))).sent).toBe(0);
    expect((await h.tick([A({ id: 'NEW' })], t('12:01'))).sent).toBe(1);
  });

  it('ignores survive a restart', async () => {
    await h.repos.ignores.upsert('1001', 'Charlie[USAF]', t('13:00'), 'admin');
    await h.restart();
    expect((await h.tick([A()], t('12:00'))).sent).toBe(0);
  });
});

describe('failure handling', () => {
  it('a failed delivery rolls the cooldown back and is retried next cycle', async () => {
    h = await createHarness({ sendBackoffMs: 0 });
    h.notifier.failNext = 1;
    expect((await h.tick([A()], t('12:00'))).sent).toBe(0);
    expect(await h.repos.cooldowns.get('1001')).toBeNull(); // claim was released
    expect((await h.tick([A()], t('12:00:10'))).sent).toBe(1); // retried, not lost
    expect(await h.repos.cooldowns.get('1001')).not.toBeNull();
  });

  it('rollback restores the previous cooldown timestamp (does not erase history)', async () => {
    h = await createHarness({ sendBackoffMs: 0 });
    await h.tick([A()], t('12:00'));
    h.notifier.failNext = 1;
    await h.tick([A()], t('12:10'));
    expect((await h.repos.cooldowns.get('1001'))!.lastAlertAt.toISOString()).toBe(t('12:00').toISOString());
    expect((await h.tick([A()], t('12:10:10'))).sent).toBe(1);
  });

  it('send backoff prevents hammering Discord while it is failing', async () => {
    h = await createHarness({ sendBackoffMs: 30_000 });
    h.notifier.failNext = 1; h.notifier.failPermanent = true;
    await h.tick([A()], t('12:00:00'));
    expect((await h.tick([A()], t('12:00:10'))).sent).toBe(0); // within backoff
    expect((await h.tick([A()], t('12:00:31'))).sent).toBe(1);
  });

  it('unconfigured notifications neither alert nor consume the cooldown', async () => {
    h = await createHarness({ configured: false });
    expect((await h.tick([A()], t('12:00'))).sent).toBe(0);
    expect(await h.repos.cooldowns.get('1001')).toBeNull();
    await h.config.setChannel('111111111111111111'); await h.config.setRole('222222222222222222');
    expect((await h.tick([A()], t('12:01'))).sent).toBe(1);
  });
});

describe('storage failure during a cycle', () => {
  it('a failed cycle sends nothing, does not wedge the manager, and the next cycle recovers', async () => {
    h = await createHarness();
    const real = h.repos.ignores.listActive.bind(h.repos.ignores);
    let down = true;
    h.repos.ignores.listActive = async (now: Date) => { if (down) throw new Error('connection terminated'); return real(now); };
    await expect(h.tick([A()], t('12:00'))).rejects.toThrow(/connection terminated/);
    expect(h.notifier.sent).toHaveLength(0);
    down = false;
    expect((await h.tick([A()], t('12:00:10'))).sent).toBe(1); // not wedged by the failed cycle, alert not lost
  });
});

describe('geography in the pipeline', () => {
  it('territorial waters trigger alerts (Indian 12 NM sea)', async () => {
    h = await createHarness();
    await h.tick([A(PLACE.mumbaiSea)], t('12:00'));
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]).toMatchObject({ tier: '12nm' });
    expect(h.notifier.sent[0]!.country.iso3).toBe('IND');
  });

  it('only monitored countries alert (France is not monitored)', async () => {
    h = await createHarness();
    expect((await h.tick([A(PLACE.paris)], t('12:00'))).sent).toBe(0);
  });

  it('removing a country stops alerts for it immediately', async () => {
    h = await createHarness();
    await h.config.removeCountry('IND');
    expect((await h.tick([A(PLACE.delhi)], t('12:00'))).sent).toBe(0);
  });

  it('disputed areas alert when ANY claimant is monitored and name the other claimants', async () => {
    h = await createHarness({ countries: ['India'] });
    await h.tick([A(PLACE.siachen)], t('12:00'));
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]!.country.iso3).toBe('IND');
    expect(h.notifier.sent[0]!.otherClaimants.map((c) => c.iso3)).toEqual(['PAK']);
  });

  it('an unresolved position never alerts, even if everything else matches', async () => {
    h = await createHarness();
    expect((await h.tick([A(PLACE.midAtlantic)], t('12:00'))).sent).toBe(0);
  });
});
