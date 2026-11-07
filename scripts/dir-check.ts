import { GeoEngine } from '../src/geo/engine.js';
import { CountryDirectory, AoBoxes } from '../src/geo/countries.js';
const g = GeoEngine.load();
const dir = new CountryDirectory([...g.sovereigns.values()], g.territories);
for (const q of ['India', 'united states', 'USA', 'us', 'UK', 'Nepal', 'Pakistan', 'Guam', 'Hong Kong', 'Congo', 'Korea', 'Turkiye', 'Ivory coast', 'Cote d\'Ivoire', 'Kosovo', 'zzz', 'Czech Republic', 'Burma', 'Macedonia', 'Swaziland', 'Palestine', 'Taiwan']) {
  const r = dir.lookup(q);
  console.log(q.padEnd(16), r.kind, r.kind === 'found' ? `${r.country.iso3} ${r.country.name} ${r.country.iso2}` : r.kind === 'territory' ? `${r.territory} -> ${r.sovereigns.map(s=>s.name)}` : r.kind === 'ambiguous' ? r.candidates.map((c) => c.name).join(', ') : '');
}
const ao = AoBoxes.load(dir);
const chk = (n: string, la: number, lo: number, iso: string) => console.log('AO', n, iso, ao.contains(iso, la, lo));
chk('Delhi in IND box', 28.6, 77.2, 'IND'); chk('Delhi vs PAK box', 28.6, 77.2, 'PAK'); chk('Guam in USA(territory box)', 13.44, 144.79, 'USA'); chk('Fiji dateline', -17.7, -179.9, 'FJI');
console.log('sovereigns without any AO box:', [...g.sovereigns.keys()].filter((i) => !ao.hasBoxFor(i)).join(' '));
