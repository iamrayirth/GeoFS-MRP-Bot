/**
 * Builds data/geodata.json.gz — the bundled country geometry used by the geo engine.
 *
 * Sources (see docs/GEODATA.md):
 *  - LAND:  Natural Earth 1:10m Admin-0 countries (public domain), via the `world-atlas` npm package.
 *  - SEA:   Marine Regions / VLIZ "Maritime Boundaries v12" via the public WFS
 *           (layers eez_12nm = Territorial Seas, eez_internal_waters, eez_archipelagic_waters), CC-BY 4.0.
 *  - TABLE: territory -> sovereign mapping from the VLIZ eez_land attribute table (attributes only; its geometry is
 *           "land + full EEZ" and is deliberately NOT used, because the EEZ is not territorial water).
 *
 * Usage: npm run build:geodata        (downloads ~250 MB into .cache/geodata on first run; needs network)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import countries from 'i18n-iso-countries';

const require = createRequire(import.meta.url);
const WFS = 'https://geo.vliz.be/geoserver/MarineRegions/wfs';
const CACHE = '.cache/geodata';
// Territorial seas (the zone that matters most) keep a fine tolerance; internal waters adjoin the coast and are coarser.
const SEA_LAYERS = [
  { layer: 'eez_internal_waters', tier: 'internal', meters: 750, precision: 0.001 },
  { layer: 'eez_archipelagic_waters', tier: 'archipelagic', meters: 500, precision: 0.001 },
  { layer: 'eez_12nm', tier: '12nm', meters: 200, precision: 0.0001 },
] as const;

mkdirSync(CACHE, { recursive: true });

async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  console.log('downloading', url.slice(0, 140));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
const wfsUrl = (layer: string, extra = '') =>
  `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=MarineRegions:${layer}&outputFormat=application/json&srsName=EPSG:4326${extra}`;

interface TerRow { un: number; name: string; sov: string[]; }

async function main() {
  // 1. territory table (attributes only)
  const tableFile = `${CACHE}/eez_land_attrs.json`;
  await download(
    wfsUrl('eez_land', '&propertyName=territory1,iso_ter1,un_ter1,sovereign1,iso_sov1,un_sov1,pol_type'),
    tableFile,
  );
  const table = JSON.parse(readFileSync(tableFile, 'utf8')).features.map((f: any) => f.properties);
  // The VLIZ table is not perfectly consistent (e.g. Gibraltar is coded iso_sov1='GIB' under sovereign 'United Kingdom').
  // Canonical code per sovereign NAME = its most frequent iso_sov1.
  const votes = new Map<string, Map<string, number>>();
  const vote = (name: string | null, iso: string | null) => {
    if (!name || !iso) return;
    const m = votes.get(name) ?? new Map<string, number>();
    m.set(iso, (m.get(iso) ?? 0) + 1);
    votes.set(name, m);
  };
  for (const p of table) { vote(p.sovereign1, p.iso_sov1); vote(p.sovereign2, p.iso_sov2); vote(p.sovereign3, p.iso_sov3); }
  const canon = new Map<string, string>(); // name -> iso3
  for (const [name, m] of votes) canon.set(name, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  const sovereigns = new Map<string, string>(); // iso3 -> name
  for (const [name, iso] of canon) sovereigns.set(iso, name);
  const codeOf = (name: string | null) => (name ? canon.get(name) ?? null : null);

  const byUn = new Map<number, TerRow>();
  for (const p of table) {
    if (p.un_ter1 == null || byUn.has(p.un_ter1)) continue;
    if (p.pol_type === 'Joint regime (EEZ)') continue;
    const claimants =
      p.pol_type === 'Overlapping claim'
        ? [p.sovereign1, p.sovereign2, p.sovereign3].map(codeOf).filter((x): x is string => !!x)
        : [codeOf(p.sovereign1)].filter((x): x is string => !!x);
    if (!claimants.length) continue;
    byUn.set(p.un_ter1, { un: p.un_ter1, name: p.territory1, sov: [...new Set(claimants)] });
  }

  // 2. sea layers: download, simplify with mapshaper (topology-aware), tag tier
  const features: any[] = [];
  for (const { layer, tier, meters, precision } of SEA_LAYERS) {
    const raw = `${CACHE}/${layer}.json`;
    await download(wfsUrl(layer), raw);
    const out = `${CACHE}/${layer}.simplified.json`;
    console.log(`simplifying ${layer} @ ${meters} m`);
    execFileSync(
      'node',
      [
        '--max-old-space-size=6000',
        require.resolve('mapshaper/bin/mapshaper'),
        '-i', raw,
        '-simplify', `interval=${meters}`, 'keep-shapes',
        '-filter-fields', 'un_ter1,iso_ter1,territory1,un_sov1,iso_sov1,sovereign1',
        '-o', out, `precision=${precision}`,
      ],
      { stdio: 'inherit' },
    );
    for (const f of JSON.parse(readFileSync(out, 'utf8')).features) {
      const p = f.properties ?? {};
      const sov = codeOf(p.sovereign1);
      if (!sov || !f.geometry) { console.warn('skip sea feature without sovereign', p); continue; }
      features.push({ type: 'Feature', properties: { tier, sov: [sov], ter: p.territory1 ?? p.sovereign1 }, geometry: f.geometry });
    }
  }

  // 3. land from Natural Earth
  const topo = require('world-atlas/countries-10m.json');
  const land: any = feature(topo, topo.objects.countries);
  // Natural Earth entities without a numeric id. Disputed/leased areas list every claimant (alert logic treats a
  // match on ANY claimant as a match and shows the full list). Anything not listed here is skipped on purpose.
  const MANUAL: Record<string, { sov: string[]; ter: string } | null> = {
    Kosovo: { sov: ['XKX'], ter: 'Kosovo' },
    Somaliland: { sov: ['SOM'], ter: 'Somaliland' },
    'N. Cyprus': { sov: ['CYP', 'TUR'], ter: 'Northern Cyprus' },
    'Cyprus U.N. Buffer Zone': { sov: ['CYP'], ter: 'UN Buffer Zone' },
    Akrotiri: { sov: ['GBR'], ter: 'Akrotiri' },
    Dhekelia: { sov: ['GBR'], ter: 'Dhekelia' },
    'USNB Guantanamo Bay': { sov: ['USA'], ter: 'Guantanamo Bay' },
    Baikonur: { sov: ['KAZ', 'RUS'], ter: 'Baikonur' },
    'Siachen Glacier': { sov: ['IND', 'PAK'], ter: 'Siachen Glacier' },
    'Indian Ocean Ter.': { sov: ['AUS'], ter: 'Australian Indian Ocean Territories' },
    'Coral Sea Is.': { sov: ['AUS'], ter: 'Coral Sea Islands' },
    'Clipperton I.': { sov: ['FRA'], ter: 'Clipperton' },
    'Spratly Is.': { sov: ['CHN', 'TWN', 'VNM', 'PHL', 'MYS', 'BRN'], ter: 'Spratly Islands' },
    'Scarborough Reef': { sov: ['PHL', 'CHN', 'TWN'], ter: 'Scarborough Shoal' },
    'Bajo Nuevo Bank': { sov: ['COL', 'NIC', 'JAM', 'USA'], ter: 'Bajo Nuevo Bank' },
    'Serranilla Bank': { sov: ['COL', 'NIC', 'JAM', 'USA'], ter: 'Serranilla Bank' },
    'Hong Kong': { sov: ['CHN'], ter: 'Hong Kong' },
    Macao: { sov: ['CHN'], ter: 'Macao' },
    Åland: { sov: ['FIN'], ter: 'Åland' },
    Sudan: { sov: ['SDN'], ter: 'Sudan' },
    Gibraltar: { sov: ['GBR'], ter: 'Gibraltar' },
    'Br. Indian Ocean Ter.': { sov: ['MUS', 'GBR'], ter: 'Chagos Archipelago' },
    'S. Geo. and the Is.': { sov: ['GBR', 'ARG'], ter: 'South Georgia and the South Sandwich Islands' },
    'Falkland Is.': { sov: ['GBR', 'ARG'], ter: 'Falkland Islands' },
    'W. Sahara': { sov: ['MAR', 'ESH'], ter: 'Western Sahara' },
    Antarctica: null, // not a country
  };
  const unmapped: string[] = [];
  for (const f of land.features) {
    const name: string = f.properties.name;
    let sov: string[]; let ter: string;
    const man = MANUAL[name];
    if (name in MANUAL) {
      if (man === null) continue;
      ({ sov, ter } = man);
    } else {
      const row = f.id != null ? byUn.get(Number(f.id)) : undefined;
      if (!row) { unmapped.push(`${f.id}:${name}`); continue; }
      sov = row.sov; ter = row.name;
    }
    for (const s of sov) if (!sovereigns.has(s)) { console.warn('land code not in sovereign table:', s, ter); sovereigns.set(s, ter); }
    features.push({ type: 'Feature', properties: { tier: 'land', sov, ter }, geometry: f.geometry });
  }
  if (unmapped.length) console.warn(`WARNING: ${unmapped.length} Natural Earth land features unmapped:`, unmapped.join(', '));

  // 4. sovereign table with ISO alpha-2 (for flags)
  const sovList = [...sovereigns.entries()]
    .map(([iso3, name]) => ({ iso3, iso2: iso3 === 'XKX' ? 'XK' : countries.alpha3ToAlpha2(iso3) ?? null, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out = {
    type: 'FeatureCollection',
    meta: {
      generatedAt: new Date().toISOString(),
      simplifyMeters: Object.fromEntries(SEA_LAYERS.map((l) => [l.tier, l.meters])),
      land: 'Natural Earth 1:10m Admin-0 Countries (world-atlas)',
      sea: 'Marine Regions (VLIZ) Maritime Boundaries v12: eez_12nm, eez_internal_waters, eez_archipelagic_waters',
      tiers: ['land', 'internal', 'archipelagic', '12nm'],
    },
    sovereigns: sovList,
    features,
  };
  const json = JSON.stringify(out);
  writeFileSync('data/geodata.json.gz', gzipSync(Buffer.from(json), { level: 9 }));
  console.log(`features=${features.length} sovereigns=${sovList.length} json=${(json.length / 1e6).toFixed(1)}MB -> data/geodata.json.gz`);
}
main().catch((e) => { console.error(e); process.exit(1); });
