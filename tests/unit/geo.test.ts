import { beforeAll, describe, expect, it } from 'vitest';
import { COASTAL_SNAP_METERS, GeoEngine, ringDistanceMeters, type GeoData } from '../../src/geo/engine.js';

describe('country detection (real bundled dataset)', () => {
  let geo: GeoEngine;
  beforeAll(() => { geo = GeoEngine.load(); });
  const iso = (lat: number, lon: number) => geo.resolve(lat, lon).countries.map((c) => c.iso3);

  it.each([
    ['New Delhi', 28.6139, 77.209, 'IND'],
    ['Kathmandu', 27.7172, 85.324, 'NPL'],
    ['Lahore', 31.5204, 74.3587, 'PAK'],
    ['Washington DC', 38.8977, -77.0365, 'USA'],
    ['Honolulu', 21.3069, -157.8583, 'USA'],
    ['Paris', 48.8566, 2.3522, 'FRA'],
    ['Nairobi', -1.2921, 36.8219, 'KEN'],
    ['Sydney', -33.8688, 151.2093, 'AUS'],
    ['Moscow', 55.7558, 37.6173, 'RUS'],
    ['Vatican City', 41.9029, 12.4534, 'VAT'],
  ])('%s is on land in %s', (_n, lat, lon, expected) => {
    const r = geo.resolve(lat, lon);
    expect(r.status).toBe('resolved');
    expect(r.tier).toBe('land');
    expect(iso(lat, lon)).toEqual([expected]);
  });

  it('territories resolve to their sovereign and report the territory', () => {
    const r = geo.resolve(13.4443, 144.7937); // Guam
    expect(r.countries.map((c) => c.iso3)).toEqual(['USA']);
    expect(r.territory).toBe('Guam');
  });

  it('territorial waters count: 5 NM off Mumbai is Indian 12 NM sea', () => {
    const r = geo.resolve(18.95, 72.63);
    expect(r.status).toBe('resolved');
    expect(r.tier).toBe('12nm');
    expect(r.countries[0]!.iso3).toBe('IND');
  });

  it('open ocean beyond territorial waters is unresolved - never guessed', () => {
    expect(geo.resolve(18.95, 70.4).status).toBe('unresolved'); // ~100 NM off Mumbai
    expect(geo.resolve(30, -40).status).toBe('unresolved'); // mid-Atlantic
  });

  it('the EEZ is NOT treated as territorial water (US EEZ ~100 NM south of Nantucket)', () => {
    expect(geo.resolve(39.5, -70.0).status).toBe('unresolved');
  });

  it('Antarctica and invalid coordinates are unresolved', () => {
    expect(geo.resolve(-80, 0).status).toBe('unresolved');
    expect(geo.resolve(NaN, 0).status).toBe('unresolved');
    expect(geo.resolve(91, 0).status).toBe('unresolved');
    expect(geo.resolve(0, 181).status).toBe('unresolved');
  });

  it('the 12 NM zone ends where it should: Oregon coast sits within 11-14 NM of shore', () => {
    // walk west along 44.0N from inland; the territorial sea must end between ~11 and ~14 NM past the coast
    let coast: number | null = null; let end: number | null = null;
    for (let i = 0; i < 1500; i++) {
      const lon = -123.5 - i * 0.001;
      const r = geo.resolve(44.0, lon);
      if (r.tier === '12nm' && coast === null) coast = lon;
      if (r.status === 'unresolved' && coast !== null) { end = lon; break; }
    }
    expect(coast).not.toBeNull(); expect(end).not.toBeNull();
    const nm = ((coast! - end!) * 111.32 * Math.cos((44 * Math.PI) / 180)) / 1.852;
    expect(nm).toBeGreaterThan(11);
    expect(nm).toBeLessThan(14);
  });

  it('handles the antimeridian: Fiji resolves on both sides of 180°', () => {
    expect(iso(-17.7, 178.9)).toEqual(['FJI']);
    expect(iso(-17.7, -179.9)).toEqual(['FJI']);
  });

  it('disputed land is reported as ambiguous with all claimants (Siachen: India/Pakistan)', () => {
    const r = geo.resolve(35.42, 77.1);
    expect(r.status).toBe('ambiguous');
    expect(r.countries.map((c) => c.iso3).sort()).toEqual(['IND', 'PAK']);
  });

  it('boundary edge: a point exactly on a country border still resolves (not dropped)', () => {
    // vertex taken straight from the data: the Nepal polygon outer ring
    const nepal = [...(geo as any).polys].find((p: any) => p.tier === 'land' && p.sov[0] === 'NPL');
    const [lon, lat] = nepal.coords[0][0];
    expect(geo.resolve(lat, lon).status).not.toBe('unresolved');
  });
});

// ---- synthetic datasets: exact control of geometry ----------------------------------------------------------------
const sq = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
function synthetic(features: { tier: any; sov: string[]; ter: string; coords: number[][][] }[]): GeoEngine {
  const data: GeoData = {
    type: 'FeatureCollection', meta: {},
    sovereigns: [['AAA', 'Aland'], ['BBB', 'Bland'], ['CCC', 'Cland']].map(([iso3, name]) => ({ iso3: iso3!, iso2: null, name: name! })),
    features: features.map((f) => ({ properties: { tier: f.tier, sov: f.sov, ter: f.ter }, geometry: { type: 'Polygon', coordinates: f.coords } })),
  };
  return new GeoEngine(data);
}

describe('geo engine logic (synthetic)', () => {
  it('land takes precedence over overlapping sea tiers', () => {
    const g = synthetic([
      { tier: '12nm', sov: ['BBB'], ter: 'Bland', coords: sq(0, 0, 10, 10) },
      { tier: 'land', sov: ['AAA'], ter: 'Aland', coords: sq(4, 4, 6, 6) },
    ]);
    expect(g.resolve(5, 5).countries[0]!.iso3).toBe('AAA');
    expect(g.resolve(1, 1).countries[0]!.iso3).toBe('BBB');
  });

  it('overlapping claims in the same tier are ambiguous and list every claimant', () => {
    const g = synthetic([
      { tier: '12nm', sov: ['AAA'], ter: 'Aland', coords: sq(0, 0, 6, 6) },
      { tier: '12nm', sov: ['BBB'], ter: 'Bland', coords: sq(4, 0, 10, 6) },
    ]);
    const r = g.resolve(3, 5);
    expect(r.status).toBe('ambiguous');
    expect(r.countries.map((c) => c.iso3).sort()).toEqual(['AAA', 'BBB']);
    expect(g.resolve(3, 1).status).toBe('resolved');
  });

  it('holes are respected (a lake inside a country is not that country)', () => {
    const g = synthetic([{ tier: 'land', sov: ['AAA'], ter: 'Aland', coords: [...sq(0, 0, 10, 10), [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] }]);
    expect(g.resolve(2, 2).status).toBe('resolved');
    expect(g.resolve(5, 5).status).toBe('unresolved');
  });

  it('snaps a point in a hairline gap between land and sea layers - but only within the tolerance', () => {
    // land to lat 1.0, 12nm starts at 1.0045 (~500 m gap)
    const g = synthetic([
      { tier: 'land', sov: ['AAA'], ter: 'Aland', coords: sq(0, 0, 1, 1) },
      { tier: '12nm', sov: ['AAA'], ter: 'Aland', coords: sq(0, 1.0045, 1, 1.2) },
    ]);
    const inGap = g.resolve(1.0022, 0.5);
    expect(inGap.status).toBe('resolved');
    expect(inGap.snapped).toBe(true);
    // 5 km beyond the sea band's edge is open water: NOT stretched
    expect(g.resolve(1.25, 0.5).status).toBe('unresolved');
  });

  it('never extends the outer edge of the 12 NM zone', () => {
    const g = synthetic([{ tier: '12nm', sov: ['AAA'], ter: 'Aland', coords: sq(0, 0, 1, 1) }]);
    expect(g.resolve(1.003, 0.5).status).toBe('unresolved'); // ~330 m outside, still no snap
  });

  it('ring distance helper is accurate at ~1 km', () => {
    const ring = sq(0, 0, 1, 1)[0]!;
    const d = ringDistanceMeters(1.009, 0.5, ring); // 0.009° lat ≈ 995 m
    expect(d).toBeGreaterThan(950); expect(d).toBeLessThan(1050);
    expect(COASTAL_SNAP_METERS).toBe(1000);
  });
});
