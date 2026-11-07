import { GeoEngine } from '../src/geo/engine.js';
const t0 = performance.now();
const g = GeoEngine.load();
console.log(`loaded ${g.polygonCount} polygons in ${(performance.now() - t0).toFixed(0)} ms; rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
const pts: [string, number, number][] = [
  ['Delhi', 28.6139, 77.209], ['Kathmandu', 27.7172, 85.324], ['Lahore', 31.5204, 74.3587], ['Hawaii Honolulu', 21.3069, -157.8583],
  ['Guam', 13.4443, 144.7937], ['Arabian Sea 5nm off Mumbai', 18.95, 72.63], ['Arabian Sea 100nm off Mumbai', 18.95, 70.4],
  ['Mid Atlantic', 30, -40], ['JFK', 40.6413, -73.7781], ['11nm off Cape Cod', 41.7, -69.6], ['20nm off Cape Cod (EEZ only)', 41.7, -69.2],
  ['Strait of Hormuz', 26.5, 56.3], ['Kashmir-ish Srinagar', 34.0837, 74.7973], ['Gibraltar', 36.1408, -5.3536], ['Antarctica', -80, 0],
  ['Dateline Fiji', -17.7, 178.9], ['Dateline Fiji E', -17.7, -179.9], ['Spratly', 10.0, 114.2], ['Jakarta Java Sea (archipelagic)', -5.5, 106.8],
];
for (const [n, lat, lon] of pts) {
  const t = performance.now();
  const r = g.resolve(lat, lon);
  console.log(n.padEnd(36), r.status.padEnd(10), String(r.tier).padEnd(12), r.countries.map((c) => c.iso3).join('/').padEnd(12), r.territory ?? '', r.snapped ? '(snapped)' : '', `${(performance.now() - t).toFixed(1)}ms`);
}
