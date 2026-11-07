import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { AircraftNames, parseAircraftList } from '../../src/geofs/aircraft-names.js';
import { GeoFsHttpError, GeoFsMapClient } from '../../src/geofs/client.js';
import { Poller } from '../../src/geofs/poller.js';

const log = pino({ level: 'silent' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = { id: '1', acid: 5, ac: 4, cs: 'A', st: { as: 100 }, co: [10, 20, 1000, 90, 0, 0], ti: null };

describe('GeoFsMapClient', () => {
  it('POSTs the passive-observer body to /map and parses users', async () => {
    const f = vi.fn(async () => json({ userCount: 1, users: [user, null] }));
    const snap = await new GeoFsMapClient('https://mps.example/map', 1000, 'ua', f as never).fetchSnapshot();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mps.example/map');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: null, gid: null }); // never sends a GeoFS account/session id
    expect(snap.observations).toHaveLength(1);
    expect(snap.rejected.notObject).toBe(1);
  });

  it.each([
    ['HTTP 500', () => json({}, 500), /HTTP 500/],
    ['invalid JSON', () => new Response('<html>', { status: 200 }), /invalid JSON/],
    ['unexpected shape', () => json({ nope: true }), /Unexpected \/map response/],
  ])('fails cleanly on %s', async (_n, make, re) => {
    const c = new GeoFsMapClient('https://x/map', 1000, 'ua', (async () => make()) as never);
    await expect(c.fetchSnapshot()).rejects.toThrow(re);
  });

  it('wraps network errors', async () => {
    const c = new GeoFsMapClient('https://x/map', 1000, 'ua', (async () => { throw new Error('ECONNRESET'); }) as never);
    await expect(c.fetchSnapshot()).rejects.toBeInstanceOf(GeoFsHttpError);
  });
});

describe('Poller', () => {
  const mk = (source: any, random = () => 0.5) => new Poller(source, async () => undefined, log, { intervalMs: 10_000, random });

  it('backs off exponentially with jitter, capped at 60s, and resets on success', async () => {
    const calls: number[] = [];
    let fail = true;
    const p = mk({ fetchSnapshot: async () => { if (fail) throw new Error('down'); return { observations: [], fetchedAt: new Date() }; } });
    p.stop(); // keep timers out of the way; drive tick() manually
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) { await p.tick(); delays.push(p.nextDelayMs()); }
    await p.stop();
    expect(delays).toEqual([20_000, 40_000, 60_000, 60_000, 60_000, 60_000]); // random()=0.5 => exact midpoint (x1.0)
    expect(p.state.consecutiveFailures).toBe(6);
    fail = false;
    await p.tick();
    await p.stop();
    expect(p.state.consecutiveFailures).toBe(0);
    expect(p.nextDelayMs()).toBe(10_000);
    expect(calls).toEqual([]);
  });

  it('a throwing snapshot handler does not stop polling', async () => {
    const p = new Poller({ fetchSnapshot: async () => ({ observations: [], fetchedAt: new Date() }) } as never, async () => { throw new Error('boom'); }, log, { intervalMs: 5000 });
    await p.tick(); await p.stop();
    expect(p.state.totalPolls).toBe(1);
    expect(p.state.lastSuccessAt).not.toBeNull();
  });
});

describe('aircraft names', () => {
  const html = `geofs.aircraftList['1'] = {name: 'Piper Cub', dir: '|a|'};geofs.aircraftList['4'] = {name: 'Boeing 737-700', dir: 'x'};geofs.aircraftList['6012'] = {name: 'Airbus A330-300 (by Jeffa &', dir: 'y'};geofs.aircraftList['9'] = {name: 'Cap\\'n Jet', dir: 'z'};`;
  it('parses the table embedded in the GeoFS page (incl. server-truncated and escaped names)', () => {
    const m = parseAircraftList(html);
    expect(m.get(1)).toBe('Piper Cub');
    expect(m.get(6012)).toBe('Airbus A330-300 (by Jeffa &');
    expect(m.get(9)).toBe("Cap'n Jet");
    expect(m.size).toBe(4);
  });
  it('bundled snapshot maps real ids and never invents names', () => {
    const n = new AircraftNames(log);
    expect(n.size).toBeGreaterThan(150);
    expect(n.resolve(25, '25')).toEqual({ label: 'Boeing 777-300ER', known: true });
    expect(n.resolve(2525, '2525')).toEqual({ label: 'Unknown (aircraft ID 2525)', known: false });
    expect(n.resolve(null, null)).toEqual({ label: 'Unknown', known: false });
    expect(n.resolve(null, 'abc')).toEqual({ label: 'Unknown (aircraft ID abc)', known: false });
  });
  it('refuses to replace the table with a suspiciously small parse', async () => {
    const n = new AircraftNames(log, 'https://x', (async () => new Response(html)) as never);
    const before = n.size;
    expect(await n.refresh()).toBe(false);
    expect(n.size).toBe(before);
  });
});
