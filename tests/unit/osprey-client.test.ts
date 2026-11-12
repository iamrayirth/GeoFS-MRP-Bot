import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { escapeRegex, identifierPattern, OspreyClient, parseOspreyUser } from '../../src/osprey/client.js';

const log = pino({ level: 'silent' });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A user object shaped exactly like the fields the reference implementation (cynkcrl-ux/GeoFS-MRP-Track-) reads.
const user = {
  accountID: 2145266, currentCallsign: 'Charlie[USAF]', Online: true, pastCallsigns: ['OldName', 'Charlie', 'OldName', 42, ''],
  events: [
    { event: { type: 'login', timestamp: '2026-11-01T10:00:00Z' } },
    { event: { type: 'login', timestamp: '2026-11-05T09:30:00Z' } },
    { event: { type: 'account_created', timestamp: '2024-02-03T00:00:00Z' } },
    { event: { type: 'something_else', timestamp: '2026-11-06T00:00:00Z' } },
    { event: { type: 'login', timestamp: 'garbage' } },
    null,
  ],
};

type Call = { url: string; signal?: AbortSignal | null };
function mk(handler: (url: string, n: number) => Response | Promise<Response>, opts: Partial<ConstructorParameters<typeof OspreyClient>[1]> = {}) {
  const calls: Call[] = [];
  let now = 1_000_000;
  const sleeps: number[] = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, signal: init?.signal }); return handler(url, calls.length); }) as unknown as typeof fetch;
  const c = new OspreyClient(log, { base: 'https://osprey.test/api/v2/', fetchImpl: f, now: () => now, sleep: async (ms) => { sleeps.push(ms); }, ...opts });
  return { c, calls, sleeps, advance: (ms: number) => { now += ms; } };
}

describe('parseOspreyUser', () => {
  it('extracts identity using the reference fields, picking the LATEST login and the earliest creation', () => {
    expect(parseOspreyUser(user)).toEqual({
      accountId: '2145266', callsign: 'Charlie[USAF]', online: true,
      pastCallsigns: ['OldName', 'Charlie'], // strings only, de-duplicated, blanks dropped
      lastLoginAt: new Date('2026-11-05T09:30:00Z'), createdAt: new Date('2024-02-03T00:00:00Z'),
    });
  });
  it('never invents values', () => {
    expect(parseOspreyUser({ accountID: 5 })).toEqual({ accountId: '5', callsign: null, online: null, pastCallsigns: [], lastLoginAt: null, createdAt: null });
    expect(parseOspreyUser({ accountID: 5, Online: 'yes' })!.online).toBeNull();
    expect(parseOspreyUser({ accountID: 5, Online: false })!.online).toBe(false);
  });
  it.each([null, undefined, 'x', 5, [], {}, { Online: true }, { accountID: '' }])('rejects %j', (v) => expect(parseOspreyUser(v)).toBeNull());
});

describe('regex pattern for the pattern search', () => {
  it('escapes literals the way the reference does for brackets (and the "/" delimiter)', () => {
    expect(escapeRegex('[USAF]')).toBe('\\[USAF\\]');
    expect(identifierPattern(['[USAF]', 'a/b', 'x.y'])).toBe('\\[USAF\\]|a\\/b|x\\.y');
  });
});

describe('GET /users/?acid=', () => {
  it('requests the reference URL, parses, and caches', async () => {
    const t = mk(() => json(user));
    const r = await t.c.byAcid(2145266);
    expect(t.calls[0]!.url).toBe('https://osprey.test/api/v2/users/?acid=2145266');
    expect(r).toMatchObject({ status: 'ok', via: 'acid', identity: { accountId: '2145266' } });
    await t.c.byAcid('2145266');
    expect(t.calls).toHaveLength(1); // served from cache
    t.advance(11 * 60_000);
    await t.c.byAcid(2145266);
    expect(t.calls).toHaveLength(2); // positive TTL (10 min) expired
  });
  it('404 => not_found with a short negative cache', async () => {
    const t = mk(() => new Response('nope', { status: 404 }));
    expect(await t.c.byAcid(1)).toEqual({ status: 'not_found' });
    await t.c.byAcid(1);
    expect(t.calls).toHaveLength(1);
    t.advance(3 * 60_000);
    await t.c.byAcid(1);
    expect(t.calls).toHaveLength(2);
  });
  it('non-numeric ids never reach the network', async () => {
    const t = mk(() => json(user));
    expect(await t.c.byAcid('1; drop')).toEqual({ status: 'not_found' });
    expect(t.calls).toHaveLength(0);
  });
  it('de-duplicates concurrent identical lookups', async () => {
    const t = mk(async () => { await new Promise((r) => setTimeout(r, 10)); return json(user); });
    await Promise.all([t.c.byAcid(7), t.c.byAcid(7), t.c.byAcid(7)]);
    expect(t.calls).toHaveLength(1);
  });
});

describe('GET /users/search?exact_callsign=', () => {
  it('encodes the callsign and uses the first result', async () => {
    const t = mk(() => json({ results: [user, { accountID: 9, currentCallsign: 'other' }] }));
    const r = await t.c.byExactCallsign('Charlie[USAF]');
    expect(t.calls[0]!.url).toBe('https://osprey.test/api/v2/users/search?exact_callsign=Charlie%5BUSAF%5D');
    expect(r).toMatchObject({ status: 'ok', via: 'callsign', identity: { accountId: '2145266' } });
  });
  it('empty results => not_found', async () => {
    const t = mk(() => json({ results: [] }));
    expect(await t.c.byExactCallsign('ghost')).toEqual({ status: 'not_found' });
  });
});

describe('lookup(): account id first, exact callsign as fallback', () => {
  it('falls back to the callsign only when the account id is unknown to Osprey', async () => {
    const t = mk((url) => (url.includes('/users/?acid=') ? new Response('', { status: 404 }) : json({ results: [user] })));
    const r = await t.c.lookup({ accountId: 5, callsign: 'Charlie[USAF]' });
    expect(r.status).toBe('ok');
    expect(t.calls.map((c) => c.url.includes('exact_callsign'))).toEqual([false, true]);
  });
  it('does not fall back when Osprey itself is failing', async () => {
    const t = mk(() => json({}, 500));
    expect((await t.c.lookup({ accountId: 5, callsign: 'x' })).status).toBe('unavailable');
    expect(t.calls).toHaveLength(1);
  });
  it('callsign-only and nothing-to-look-up cases', async () => {
    const t = mk(() => json({ results: [user] }));
    expect((await t.c.lookup({ accountId: null, callsign: 'Charlie[USAF]' })).status).toBe('ok');
    expect(await t.c.lookup({ accountId: null, callsign: '' })).toEqual({ status: 'not_found' });
  });
});

describe('rate limiting, failures and the circuit breaker', () => {
  it('HTTP 429: honours Retry-After, retries exactly once', async () => {
    const t = mk((_u, n) => (n === 1 ? json({}, 429, { 'retry-after': '3' }) : json(user)));
    expect((await t.c.byAcid(1)).status).toBe('ok');
    expect(t.sleeps).toEqual([3000]);
    expect(t.calls).toHaveLength(2);
  });
  it('HTTP 429 without Retry-After waits 8 s (the reference value); a second 429 gives up (no infinite loop)', async () => {
    const t = mk(() => json({}, 429));
    const r = await t.c.byAcid(1);
    expect(t.sleeps).toEqual([8000]);
    expect(t.calls).toHaveLength(2);
    expect(r).toMatchObject({ status: 'unavailable', error: expect.stringMatching(/429/) });
  });
  it.each([
    ['HTTP 500', () => json({}, 500), /HTTP 500/],
    ['invalid JSON', () => new Response('<html>', { status: 200 }), /invalid JSON/],
  ])('%s => unavailable (never throws)', async (_n, make, re) => {
    const t = mk(make);
    expect(await t.c.byAcid(1)).toMatchObject({ status: 'unavailable', error: expect.stringMatching(re) });
  });
  it('network errors and timeouts => unavailable', async () => {
    const t = mk(() => { throw new Error('ECONNRESET'); });
    expect(await t.c.byAcid(1)).toMatchObject({ status: 'unavailable', error: expect.stringMatching(/ECONNRESET/) });
    const slow = mk((_u) => new Promise<Response>(() => undefined), { timeoutMs: 30, fetchImpl: ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as never });
    expect((await slow.c.byAcid(1)).status).toBe('unavailable');
  });
  it('after 3 consecutive failures Osprey is left alone for a minute, then retried', async () => {
    const t = mk(() => json({}, 503));
    for (let i = 1; i <= 3; i++) await t.c.byAcid(i);
    expect(t.calls).toHaveLength(3);
    expect(await t.c.byAcid(4)).toMatchObject({ status: 'unavailable' });
    expect(t.calls).toHaveLength(3); // no request: breaker open
    expect(t.c.health()).toMatchObject({ ok: false, consecutiveFailures: 3 });
    t.advance(61_000);
    await t.c.byAcid(5);
    expect(t.calls).toHaveLength(4);
  });
  it('a success resets the failure count and reports health', async () => {
    let ok = false;
    const t = mk(() => (ok ? json(user) : json({}, 500)));
    await t.c.byAcid(1); await t.c.byAcid(2);
    ok = true;
    await t.c.byAcid(3);
    expect(t.c.health()).toMatchObject({ ok: true, consecutiveFailures: 0, lastError: null });
  });
});

describe('GET /users/search?pattern= (roster)', () => {
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ accountID: from + i, currentCallsign: `P${from + i}[USAF]` }));
  it('sends the reference request shape (pattern=/<regex>/i&page&per_page=100) and paginates until a short page', async () => {
    const t = mk((url) => json({ results: url.includes('&page=1&') ? page(100, 0) : page(30, 100), count: 130 }));
    const r = await t.c.roster(['[USAF]', '[RAF]']);
    expect(r).toMatchObject({ status: 'ok', truncated: false });
    expect(r.status === 'ok' && r.entries).toHaveLength(130);
    const u = new URL(t.calls[0]!.url);
    expect(u.pathname).toBe('/api/v2/users/search');
    expect(u.searchParams.get('pattern')).toBe('/\\[USAF\\]|\\[RAF\\]/i');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('per_page')).toBe('100');
    expect(t.calls).toHaveLength(2);
  });
  it('is capped (truncated flag) and cached for 60 s', async () => {
    const t = mk(() => json({ results: page(100, 0), count: 99999 }), { maxRosterPages: 2 });
    const r = await t.c.roster(['[USAF]']);
    expect(r.status === 'ok' && r.truncated).toBe(true);
    expect(t.calls).toHaveLength(2);
    await t.c.roster(['[USAF]']);
    expect(t.calls).toHaveLength(2);
    t.advance(61_000);
    await t.c.roster(['[USAF]']);
    expect(t.calls).toHaveLength(4);
  });
  it('no identifiers => no request; failures => unavailable', async () => {
    const t = mk(() => json({}, 500));
    expect(await t.c.roster([])).toEqual({ status: 'ok', entries: [], truncated: false });
    expect(t.calls).toHaveLength(0);
    expect((await t.c.roster(['[A]'])).status).toBe('unavailable');
  });
});
