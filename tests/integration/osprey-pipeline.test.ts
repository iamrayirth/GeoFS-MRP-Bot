import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAlertMessage } from '../../src/alerts/embed.js';
import type { OspreyLookup } from '../../src/osprey/client.js';
import { createHarness, obs, PLACE, t, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });
const A = (over: Record<string, unknown> = {}) => obs({ id: '1001', callsign: 'Charlie[USAF]', accountId: 2145266, ...PLACE.delhi, ...over });
const ident = { accountId: '2145266', callsign: 'Charlie[USAF]', online: true, pastCallsigns: ['Old1', 'Old2'], lastLoginAt: new Date('2026-11-05T09:30:00Z'), createdAt: new Date('2024-02-03T00:00:00Z') };
const fake = (impl: (q: any) => Promise<OspreyLookup>) => ({ lookup: vi.fn(impl) });

describe('Osprey enrichment of alerts', () => {
  it('attaches the identity (looked up by the GeoFS account id + callsign) and renders it in the embed', async () => {
    const identity = fake(async () => ({ status: 'ok', identity: ident, via: 'acid' }));
    h = await createHarness({ identity });
    await h.tick([A()], t('12:00'));
    expect(identity.lookup).toHaveBeenCalledWith({ accountId: 2145266, callsign: 'Charlie[USAF]' });
    const p = h.notifier.sent[0]!;
    expect(p.osprey).toEqual({ status: 'ok', identity: ident });
    const fields = Object.fromEntries(buildAlertMessage(p).embeds[0]!.toJSON().fields!.map((f) => [f.name, f.value]));
    expect(fields['Osprey identity']).toContain('Account ID: `2145266`');
    expect(fields['Osprey identity']).toContain('`Old1`, `Old2`');
    expect(fields['Osprey identity']).toContain('Last login: <t:');
  });

  it('only looks up when an alert is actually going to be sent (not during cooldown)', async () => {
    const identity = fake(async () => ({ status: 'ok', identity: ident, via: 'acid' }));
    h = await createHarness({ identity });
    await h.tick([A()], t('12:00'));
    await h.tick([A()], t('12:03'));
    await h.tick([A()], t('12:05'));
    expect(identity.lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not found', async () => ({ status: 'not_found' }) as OspreyLookup, 'not_found'],
    ['unavailable', async () => ({ status: 'unavailable', error: 'HTTP 502' }) as OspreyLookup, 'unavailable'],
    ['throws', async () => { throw new Error('boom'); }, 'unavailable'],
  ])('Osprey %s: the alert is STILL sent', async (_n, impl, status) => {
    h = await createHarness({ identity: fake(impl as never) });
    expect((await h.tick([A()], t('12:00'))).sent).toBe(1);
    expect(h.notifier.sent[0]!.osprey.status).toBe(status);
  });

  it('a hung Osprey cannot delay or lose the alert (bounded by the timeout)', async () => {
    h = await createHarness({ identity: fake(() => new Promise<OspreyLookup>(() => undefined)), identityTimeoutMs: 40 });
    const t0 = Date.now();
    expect((await h.tick([A()], t('12:00'))).sent).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(h.notifier.sent[0]!.osprey.status).toBe('unavailable');
  });

  it('disabled integration: no field, no lookups', async () => {
    h = await createHarness();
    await h.tick([A()], t('12:00'));
    expect(h.notifier.sent[0]!.osprey).toEqual({ status: 'disabled' });
    const names = buildAlertMessage(h.notifier.sent[0]!).embeds[0]!.toJSON().fields!.map((f) => f.name);
    expect(names).not.toContain('Osprey identity');
  });
});
