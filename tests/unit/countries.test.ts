import { beforeAll, describe, expect, it } from 'vitest';
import { AoBoxes, CountryDirectory, normalizeName } from '../../src/geo/countries.js';
import { GeoEngine } from '../../src/geo/engine.js';
import { flagEmoji } from '../../src/util/format.js';

let dir: CountryDirectory;
let geo: GeoEngine;
beforeAll(() => { geo = GeoEngine.load(); dir = new CountryDirectory([...geo.sovereigns.values()], geo.territories); });

describe('country directory', () => {
  it.each([
    ['India', 'IND'], ['india', 'IND'], ['IN', 'IND'], ['IND', 'IND'], ['United States', 'USA'], ['USA', 'USA'], ['us', 'USA'],
    ['United States of America', 'USA'], ['UK', 'GBR'], ['Pakistan', 'PAK'], ['Nepal', 'NPL'], ['Burma', 'MMR'],
    ['Czech Republic', 'CZE'], ["Cote d'Ivoire", 'CIV'], ['Türkiye', 'TUR'], ['Kosovo', 'XKX'],
  ])('%s -> %s', (q, iso3) => {
    const r = dir.lookup(q);
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.country.iso3).toBe(iso3);
  });

  it('territories are refused and point at their sovereign', () => {
    const r = dir.lookup('Guam');
    expect(r.kind).toBe('territory');
    if (r.kind === 'territory') expect(r.sovereigns.map((s) => s.iso3)).toEqual(['USA']);
  });

  it('genuinely ambiguous short names do not silently pick one', () => {
    expect(dir.lookup('Congo').kind).toBe('ambiguous');
    expect(dir.lookup('Korea').kind).toBe('ambiguous');
  });

  it('unknown input yields none', () => expect(dir.lookup('Atlantis').kind).toBe('none'));
  it('autocomplete prefers prefix matches', () => expect(dir.suggest('ind', 5)[0]!.iso3).toBe('IND'));
  it('normalises accents and punctuation', () => expect(normalizeName("  Côte d'Ivoire ")).toBe('cote d ivoire'));
  it('flag emoji from ISO-2', () => { expect(flagEmoji('IN')).toBe('🇮🇳'); expect(flagEmoji(null)).toBeNull(); expect(flagEmoji('XKX')).toBeNull(); });
});

describe('user-supplied AO boxes (sanity cross-check only)', () => {
  it('compares a polygon result against the coarse box, incl. antimeridian boxes', () => {
    const ao = AoBoxes.load(dir);
    expect(ao.contains('IND', 28.6, 77.2)).toBe(true);
    expect(ao.contains('IND', 48.8, 2.3)).toBe(false); // Paris is not in India's box
    expect(ao.contains('FJI', -17.7, -179.9)).toBe(true); // Fiji's box crosses the antimeridian
    expect(ao.contains('FJI', -17.7, 178.9)).toBe(true);
    expect(ao.contains('USA', 13.44, 144.79)).toBe(true); // Guam box is attached to its sovereign
    expect(ao.contains('XKX', 42.6, 21.0)).toBeNull(); // no box -> no verdict
  });
});
