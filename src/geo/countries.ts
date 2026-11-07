import { readFileSync } from 'node:fs';
import countries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import type { CountryRef } from './types.js';

countries.registerLocale(enLocale as countries.LocaleData);

/** Nicer display names for sovereigns whose dataset name is awkward. */
const DISPLAY: Record<string, string> = {
  SOM: 'Somalia', COM: 'Comoros', LUX: 'Luxembourg', MUS: 'Mauritius', MKD: 'North Macedonia', SWZ: 'Eswatini',
  FSM: 'Micronesia', TLS: 'Timor-Leste', CZE: 'Czechia', COD: 'DR Congo', COG: 'Republic of the Congo',
  CIV: "Côte d'Ivoire", CPV: 'Cabo Verde', USA: 'United States', GBR: 'United Kingdom', PRK: 'North Korea', KOR: 'South Korea',
};

/** Extra spellings people actually type. Only used if the target exists in the dataset. */
const ALIASES: Record<string, string[]> = {
  USA: ['US', 'USA', 'U.S.', 'U.S.A.', 'America', 'United States of America'],
  GBR: ['UK', 'U.K.', 'Great Britain', 'Britain', 'United Kingdom of Great Britain and Northern Ireland'],
  ARE: ['UAE', 'Emirates'],
  RUS: ['Russian Federation'],
  KOR: ['Korea, Republic of', 'Republic of Korea'],
  PRK: ['Korea, Democratic People\'s Republic of', 'DPRK'],
  CZE: ['Czech Republic'],
  MMR: ['Burma'],
  CIV: ['Ivory Coast'],
  COD: ['DRC', 'Congo (Kinshasa)', 'Congo-Kinshasa', 'Democratic Republic of the Congo'],
  COG: ['Congo (Brazzaville)', 'Congo-Brazzaville'],
  CPV: ['Cape Verde'],
  TLS: ['East Timor'],
  SWZ: ['Swaziland'],
  MKD: ['Macedonia'],
  NLD: ['Holland'],
  TUR: ['Türkiye', 'Turkiye'],
  VAT: ['Holy See', 'Vatican'],
  PSE: ['Palestinian Territories', 'State of Palestine'],
  FSM: ['Federated States of Micronesia'],
  LAO: ['Lao PDR'],
  MUS: ['Republic of Mauritius'],
  SOM: ['Federal Republic of Somalia'],
  COM: ['Comores'],
  LUX: ['Grand Duchy of Luxembourg'],
};

export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

export type LookupResult =
  | { kind: 'found'; country: CountryRef }
  | { kind: 'territory'; territory: string; sovereigns: CountryRef[] }
  | { kind: 'ambiguous'; candidates: CountryRef[] }
  | { kind: 'none'; suggestions: CountryRef[] };

export class CountryDirectory {
  private readonly byIso3 = new Map<string, CountryRef>();
  private readonly index = new Map<string, string>(); // normalized alias -> iso3
  private readonly territoryIndex = new Map<string, string[]>(); // normalized territory -> iso3[]

  constructor(
    sovereigns: { iso3: string; iso2: string | null; name: string }[],
    territories: Map<string, string[]>,
  ) {
    const add = (alias: string, iso3: string) => {
      const k = normalizeName(alias);
      if (k && !this.index.has(k)) this.index.set(k, iso3);
    };
    for (const s of sovereigns) {
      const ref: CountryRef = { iso3: s.iso3, iso2: s.iso2, name: DISPLAY[s.iso3] ?? s.name };
      this.byIso3.set(s.iso3, ref);
    }
    for (const ref of this.byIso3.values()) {
      add(ref.name, ref.iso3);
      add(ref.iso3, ref.iso3);
      if (ref.iso2) add(ref.iso2, ref.iso3);
      for (const a of ALIASES[ref.iso3] ?? []) add(a, ref.iso3);
      const orig = sovereigns.find((s) => s.iso3 === ref.iso3)!.name;
      add(orig, ref.iso3);
      if (ref.iso2) {
        const names = countries.getName(ref.iso2, 'en', { select: 'all' }) as unknown;
        for (const n of Array.isArray(names) ? names : names ? [names as string] : []) add(n, ref.iso3);
      }
    }
    // Genuinely ambiguous short forms must not silently pick one country.
    this.index.delete('congo');
    this.index.delete('korea');
    for (const [ter, sov] of territories) {
      const k = normalizeName(ter);
      if (!this.index.has(k)) this.territoryIndex.set(k, sov);
    }
  }

  get all(): CountryRef[] { return [...this.byIso3.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(iso3: string): CountryRef | undefined { return this.byIso3.get(iso3); }

  /** Resolve a user-typed country (name, alias, ISO-2, ISO-3). */
  lookup(query: string): LookupResult {
    const k = normalizeName(query);
    if (!k) return { kind: 'none', suggestions: [] };
    const hit = this.index.get(k);
    if (hit) return { kind: 'found', country: this.byIso3.get(hit)! };
    const ter = this.territoryIndex.get(k);
    if (ter) return { kind: 'territory', territory: query.trim(), sovereigns: ter.map((i) => this.byIso3.get(i)!).filter(Boolean) };
    const sug = this.suggest(query, 5);
    if (sug.length === 1 && normalizeName(sug[0]!.name).startsWith(k) && k.length >= 4) return { kind: 'found', country: sug[0]! };
    if (sug.length > 1) return { kind: 'ambiguous', candidates: sug };
    return { kind: 'none', suggestions: [] };
  }

  suggest(query: string, limit = 25): CountryRef[] {
    const k = normalizeName(query);
    const all = this.all;
    if (!k) return all.slice(0, limit);
    const starts: CountryRef[] = [];
    const contains: CountryRef[] = [];
    for (const c of all) {
      const n = normalizeName(c.name);
      if (n.startsWith(k) || c.iso3.toLowerCase() === k) starts.push(c);
      else if (n.includes(k)) contains.push(c);
    }
    return [...starts, ...contains].slice(0, limit);
  }
}

// --- User supplied coarse bounding boxes (data/ao-boxes.json): sanity cross-check only --------------------------

interface Box { name: string; minLat: number; maxLat: number; minLon: number; maxLon: number; }

export class AoBoxes {
  private readonly bySovereign = new Map<string, Box[]>();
  constructor(boxes: Box[], dir: CountryDirectory) {
    for (const b of boxes) {
      const r = dir.lookup(b.name);
      const targets = r.kind === 'found' ? [r.country.iso3] : r.kind === 'territory' ? r.sovereigns.map((s) => s.iso3) : [];
      for (const t of targets) this.bySovereign.set(t, [...(this.bySovereign.get(t) ?? []), b]);
    }
  }
  static load(dir: CountryDirectory, path = new URL('../../data/ao-boxes.json', import.meta.url)): AoBoxes {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { aoBoxes: Box[] };
    return new AoBoxes(json.aoBoxes, dir);
  }
  hasBoxFor(iso3: string): boolean { return this.bySovereign.has(iso3); }
  /** true/false when a box exists for the sovereign (or its territories); null when there is none to compare against. */
  contains(iso3: string, lat: number, lon: number): boolean | null {
    const boxes = this.bySovereign.get(iso3);
    if (!boxes) return null;
    return boxes.some((b) => {
      if (lat < b.minLat || lat > b.maxLat) return false;
      // minLon > maxLon means the box crosses the antimeridian
      return b.minLon <= b.maxLon ? lon >= b.minLon && lon <= b.maxLon : lon >= b.minLon || lon <= b.maxLon;
    });
  }
}
