import { describe, expect, it } from 'vitest';
import { matchIdentifiers, normalizeIdentifier, validateIdentifier } from '../../src/tracking/identifiers.js';

const ids = (...vals: string[]) => vals.map((v) => ({ value: v, normalized: normalizeIdentifier(v) }));

describe('identifier matching', () => {
  const cfg = ids('[USAF]', '[RAF]', '[IAF]', '[NAVY]');

  it.each([
    ['Charlie[USAF]', ['[USAF]']],
    ['Delta[usaf]', ['[USAF]']],
    ['[RAF]Charlie', ['[RAF]']],
    ['x[Raf]y', ['[RAF]']],
    ['[iaf]', ['[IAF]']],
  ])('%s matches case-insensitively anywhere in the callsign', (callsign, expected) => {
    expect(matchIdentifiers(callsign, cfg)).toEqual(expected);
  });

  it('does not match when the identifier is absent or only partially present', () => {
    expect(matchIdentifiers('Charlie', cfg)).toEqual([]);
    expect(matchIdentifiers('USAF', cfg)).toEqual([]); // brackets are part of the identifier
    expect(matchIdentifiers('Charlie[USA]', cfg)).toEqual([]);
    expect(matchIdentifiers('', cfg)).toEqual([]);
  });

  it('an aircraft can match multiple identifiers', () => {
    expect(matchIdentifiers('[RAF]Pilot[USAF]', cfg).sort()).toEqual(['[RAF]', '[USAF]']);
  });

  it('removing an identifier immediately stops matching aircraft that only match it', () => {
    const before = matchIdentifiers('Charlie[USAF]', cfg);
    const after = matchIdentifiers('Charlie[USAF]', cfg.filter((c) => c.normalized !== '[usaf]'));
    expect(before).toEqual(['[USAF]']);
    expect(after).toEqual([]);
    // an aircraft matching two keeps matching the remaining one
    expect(matchIdentifiers('[RAF]x[USAF]', cfg.filter((c) => c.normalized !== '[usaf]'))).toEqual(['[RAF]']);
  });

  it('plain (non-bracket) identifiers are plain substrings', () => {
    expect(matchIdentifiers('Fooair123', ids('air'))).toEqual(['air']);
  });

  it('validates identifiers', () => {
    expect(validateIdentifier('  [USAF] ')).toEqual({ ok: true, value: '[USAF]', normalized: '[usaf]' });
    expect(validateIdentifier('   ').ok).toBe(false);
    expect(validateIdentifier('x'.repeat(33)).ok).toBe(false);
    expect(validateIdentifier('a\nb').ok).toBe(false);
  });
});
