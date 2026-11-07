/** Regenerates data/aircraft-types.json (bundled fallback) from the live GeoFS page. */
import { writeFileSync } from 'node:fs';
import { parseAircraftList } from '../src/geofs/aircraft-names.js';

const url = process.env.GEOFS_AIRCRAFT_LIST_URL ?? 'https://www.geo-fs.com/geofs.php';
const res = await fetch(url, { headers: { 'user-agent': 'GeoFS-MRP-Bot/1.0' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const map = parseAircraftList(await res.text());
if (map.size < 50) throw new Error(`parsed only ${map.size} types; refusing to write`);
const types = Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
writeFileSync('data/aircraft-types.json', JSON.stringify({ source: url, fetchedAt: new Date().toISOString(), types }, null, 1) + '\n');
console.log(`wrote ${map.size} aircraft types`);
