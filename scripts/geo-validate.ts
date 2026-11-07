import { GeoEngine } from '../src/geo/engine.js';
import { GeoFsMapClient } from '../src/geofs/client.js';
const g = GeoEngine.load();
// distance helper (haversine, nautical miles)
const nm = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 3440.065, r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
// Walk away from a coastline along a line of latitude (dir=+1 east / -1 west) and report where the 12nm zone ends.
function walk(name: string, lat: number, lonStart: number, dir: 1 | -1) {
  let coastLon: number | null = null, endLon: number | null = null, prev: string | null = null;
  for (let i = 0; i <= 2000; i++) {
    const lon = lonStart + dir * i * 0.001;
    const r = g.resolve(lat, lon);
    const tag = r.status === 'unresolved' ? 'none' : `${r.tier}`;
    if (coastLon === null && prev === 'land' && tag !== 'land') coastLon = lon;
    if (coastLon !== null && endLon === null && tag === 'none') endLon = lon;
    prev = tag === 'land' ? 'land' : prev === 'land' ? 'x' : prev;
    if (endLon !== null) break;
  }
  if (coastLon !== null && endLon !== null) console.log(`${name.padEnd(28)} coast@${coastLon.toFixed(3)} zone ends@${endLon.toFixed(3)}  width=${nm(lat, coastLon, lat, endLon).toFixed(2)} NM (expected ~12)`);
  else console.log(name, 'no coast transition found', { coastLon, endLon });
}
// start inland, walk to sea
walk('Goa India (west)', 15.3, 74.0, -1);
walk('Gujarat India', 21.5, 71.5, -1);
walk('Cape Town (west coast)', -33.5, 18.7, -1);
walk('California Big Sur', 36.0, -121.3, -1);
walk('Oregon coast', 44.0, -123.5, -1);
walk('Brittany France', 48.4, -3.0, -1);
walk('East Australia Byron', -28.65, 153.0, 1);
walk('Chile Valparaiso', -33.0, -71.2, -1);

// All live aircraft: timing and resolution breakdown
const snap = await new GeoFsMapClient(process.env.GEOFS_API ?? 'https://mps.geo-fs.com/map', 20000).fetchSnapshot();
const t0 = performance.now();
const counts: Record<string, number> = {};
let snapped = 0;
for (const o of snap.observations) {
  const r = g.resolve(o.lat, o.lon);
  const k = `${r.status}/${r.tier}`; counts[k] = (counts[k] ?? 0) + 1;
  if (r.snapped) snapped++;
}
const dt = performance.now() - t0;
console.log(`\nresolved ${snap.observations.length} live aircraft in ${dt.toFixed(0)} ms (${(dt / snap.observations.length).toFixed(2)} ms each)`, counts, 'snapped', snapped);
const t1 = performance.now();
for (const o of snap.observations) g.resolve(o.lat, o.lon);
console.log(`second pass (warm): ${(performance.now() - t1).toFixed(0)} ms`);
