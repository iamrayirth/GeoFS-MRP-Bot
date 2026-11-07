import { describe, expect, it } from 'vitest';
import { buildAlertMessage, formatAltitude, formatHeading, formatSpeed } from '../../src/alerts/embed.js';
import type { AlertPayload } from '../../src/alerts/types.js';
import { flightLevel } from '../../src/util/format.js';

const IN = { iso3: 'IND', iso2: 'IN', name: 'India' };
const base = (o: Partial<AlertPayload> = {}): AlertPayload => ({
  kind: 'entered', aircraftId: '123456', callsign: 'Charlie[USAF]', matchedIdentifiers: ['[USAF]'], aircraftTypeLabel: 'Boeing 737-800',
  lat: 28.6139, lon: 77.209, altitudeM: 10668, speedKts: 420, headingDeg: 270, country: IN, otherClaimants: [], territory: 'India', tier: 'land',
  snapped: false, detectedAt: new Date('2026-01-01T12:00:00Z'), channelId: '1', roleId: '999', ...o,
});
const fields = (p: AlertPayload) => Object.fromEntries(buildAlertMessage(p).embeds[0]!.toJSON().fields!.map((f) => [f.name, f.value]));

describe('alert embed', () => {
  it('contains every required field in the specified formats', () => {
    const m = buildAlertMessage(base());
    const e = m.embeds[0]!.toJSON();
    expect(e.title).toBe('AIRCRAFT ENTERED MONITORED TERRITORY');
    const f = fields(base());
    expect(f['Callsign']).toBe('Charlie\\[USAF\\]');
    expect(f['GeoFS Multiplayer ID']).toBe('`123456`');
    expect(f['Country']).toBe('🇮🇳 India');
    expect(f['Aircraft']).toBe('Boeing 737-800');
    expect(f['Position']).toBe('[28.6139, 77.2090](https://www.google.com/maps?q=28.61390,77.20900)');
    expect(f['Speed']).toBe('420 KTS');
    expect(f['Altitude']).toBe('FL350 (35,000 ft)');
    expect(f['Heading']).toBe('270°');
    expect(f['Detected']).toContain('2026-01-01 12:00:00 UTC');
    expect(f['Area']).toBe('Land');
  });

  it('pings the role on every alert and can mention nothing else', () => {
    for (const kind of ['entered', 'remains'] as const) {
      const m = buildAlertMessage(base({ kind }));
      expect(m.content).toBe('<@&999>');
      expect(m.allowedMentions).toEqual({ roles: ['999'], parse: [] });
    }
    expect(buildAlertMessage(base({ kind: 'remains' })).embeds[0]!.toJSON().title).toBe('AIRCRAFT REMAINS IN MONITORED TERRITORY');
  });

  it('shows Unknown instead of inventing values', () => {
    const f = fields(base({ altitudeM: null, speedKts: null, headingDeg: null, aircraftTypeLabel: 'Unknown (aircraft ID 2525)' }));
    expect(f['Altitude']).toBe('Unknown'); expect(f['Speed']).toBe('Unknown'); expect(f['Heading']).toBe('Unknown');
    expect(f['Aircraft']).toBe('Unknown (aircraft ID 2525)');
  });

  it('neutralises markdown and mentions in untrusted callsigns', () => {
    const f = fields(base({ callsign: '@everyone **bold** <@&5> `x`' }));
    expect(f['Callsign']).not.toContain('@everyone');
    expect(f['Callsign']).toContain('\\*\\*bold\\*\\*');
  });

  it('describes territory, territorial waters and disputed claims', () => {
    expect(fields(base({ tier: '12nm' }))['Area']).toBe('Territorial waters (12 NM)');
    expect(fields(base({ country: { iso3: 'USA', iso2: 'US', name: 'United States' }, territory: 'Guam' }))['Country']).toBe('🇺🇸 United States (Guam)');
    expect(fields(base({ otherClaimants: [{ iso3: 'PAK', iso2: 'PK', name: 'Pakistan' }] }))['Country']).toContain('Disputed / overlapping claim with 🇵🇰 Pakistan');
  });

  it('country without a flag code renders the name only', () => {
    expect(fields(base({ country: { iso3: 'XXX', iso2: null, name: 'Nowhere' }, territory: null }))['Country']).toBe('Nowhere');
  });

  it('stays within Discord embed limits even with hostile input', () => {
    const e = buildAlertMessage(base({ callsign: 'x'.repeat(5000), aircraftTypeLabel: 'y'.repeat(5000), matchedIdentifiers: Array(200).fill('[ABCDEFGH]') })).embeds[0]!.toJSON();
    expect(e.fields!.every((f) => f.value.length <= 1024 && f.name.length <= 256)).toBe(true);
    const total = (e.title?.length ?? 0) + e.fields!.reduce((n, f) => n + f.name.length + f.value.length, 0) + (e.footer?.text.length ?? 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(e.fields!.length).toBeLessThanOrEqual(25);
  });
});

describe('formatters', () => {
  it('flight levels', () => {
    expect(flightLevel(10668)).toBe('FL350');
    expect(flightLevel(12192)).toBe('FL400');
    expect(flightLevel(0)).toBe('FL000');
    expect(flightLevel(457.2)).toBe('FL015');
    expect(formatAltitude(null)).toBe('Unknown');
  });
  it('speed and heading', () => {
    expect(formatSpeed(0)).toBe('0 KTS');
    expect(formatHeading(5)).toBe('005°');
    expect(formatHeading(359.7)).toBe('000°');
  });
});
