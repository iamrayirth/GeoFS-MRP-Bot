import { describe, expect, it } from 'vitest';
import { normalizeHeading, parseMapResponse, parseUser } from '../../src/geofs/parse.js';

// Shapes below are taken from the real /map payload (see docs/GEOFS_INVESTIGATION.md).
const real = {
  id: '0276628518364', acid: 2145266, ac: 25, cs: 'HawaiianAirlines104', st: { gr: 0, as: 526, lv: '2' },
  co: [6.3702999, -166.0270842, 12192.12, -101.99, -1.37, 0.02], ve: [0, 0, 0, 0, 0, 0], ti: 1794068280299.3896,
};

describe('parseUser', () => {
  it('parses a real record and normalises heading', () => {
    const r = parseUser(real);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.obs).toMatchObject({ id: '0276628518364', callsign: 'HawaiianAirlines104', aircraftTypeId: 25, lat: 6.3702999, lon: -166.0270842, altitudeM: 12192.12, speedKts: 526, accountId: 2145266 });
    expect(r.obs.headingDeg).toBe(258.0); // -101.99 -> 258.0
  });

  it('rejects null entries, missing ids, bad and placeholder positions', () => {
    expect(parseUser(null)).toEqual({ ok: false, reason: 'notObject' });
    expect(parseUser([1])).toEqual({ ok: false, reason: 'notObject' });
    expect(parseUser({ ...real, id: undefined })).toEqual({ ok: false, reason: 'missingId' });
    expect(parseUser({ ...real, co: 'x' })).toEqual({ ok: false, reason: 'badPosition' });
    expect(parseUser({ ...real, co: [91, 0, 0] })).toEqual({ ok: false, reason: 'badPosition' });
    expect(parseUser({ ...real, co: [0, 181, 0] })).toEqual({ ok: false, reason: 'badPosition' });
    expect(parseUser({ ...real, co: [NaN, 0, 0] })).toEqual({ ok: false, reason: 'badPosition' });
    expect(parseUser({ ...real, co: [0, 0, 0, 0, 0, 0] })).toEqual({ ok: false, reason: 'placeholderPosition' });
  });

  it('reports implausible values as unknown instead of inventing them', () => {
    const r = parseUser({ ...real, st: { as: 600000000 }, co: [51.7, -0.45, 90916034.29, 99999, 0, 0] });
    expect(r.ok && r.obs.speedKts).toBeNull();
    expect(r.ok && r.obs.altitudeM).toBeNull();
    expect(r.ok && r.obs.headingDeg).toBeNull();
    expect(parseUser({ ...real, st: null }).ok).toBe(true);
    const n = parseUser({ ...real, st: null });
    expect(n.ok && n.obs.speedKts).toBeNull();
  });

  it('handles odd aircraft ids seen live (string, empty, null, unmapped)', () => {
    const t = (ac: unknown) => { const r = parseUser({ ...real, ac }); return r.ok ? [r.obs.aircraftTypeId, r.obs.aircraftTypeRaw] : null; };
    expect(t(25)).toEqual([25, '25']);
    expect(t('25')).toEqual([25, '25']);
    expect(t('')).toEqual([null, null]);
    expect(t(null)).toEqual([null, null]);
    expect(t('abc')).toEqual([null, 'abc']);
  });

  it('keeps empty/missing callsigns as empty strings', () => {
    const r = parseUser({ ...real, cs: undefined });
    expect(r.ok && r.obs.callsign).toBe('');
  });

  it('ti null => serverTimeMs null', () => {
    const r = parseUser({ ...real, ti: null });
    expect(r.ok && r.obs.serverTimeMs).toBeNull();
  });
});

describe('normalizeHeading', () => {
  it.each([[0, 0], [-90, 270], [360, 0], [370, 10], [-101.99, 258], [359.96, 0]])('%d -> %d', (i, o) => expect(normalizeHeading(i)).toBe(o));
  it('rejects garbage', () => { expect(normalizeHeading('x')).toBeNull(); expect(normalizeHeading(1e9)).toBeNull(); });
});

describe('parseMapResponse', () => {
  it('counts rejects and de-duplicates by id (last wins)', () => {
    const snap = parseMapResponse({ userCount: 5, users: [real, null, { ...real, cs: 'dup' }, { ...real, id: 'b', co: [0, 0, 0] }, { id: 'c', co: [1, 2, 3], cs: 'ok' }] }, new Date());
    expect(snap.observations.map((o) => o.id).sort()).toEqual(['0276628518364', 'c']);
    expect(snap.observations.find((o) => o.id === '0276628518364')!.callsign).toBe('dup');
    expect(snap.duplicateIds).toBe(1);
    expect(snap.rejected).toMatchObject({ notObject: 1, placeholderPosition: 1 });
    expect(snap.reportedUserCount).toBe(5);
  });
  it('throws on a payload without a users array', () => {
    expect(() => parseMapResponse({}, new Date())).toThrow();
    expect(() => parseMapResponse(null, new Date())).toThrow();
  });
});
