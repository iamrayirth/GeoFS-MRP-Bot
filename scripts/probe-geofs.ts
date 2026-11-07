/**
 * Phase-1 verification tool: polls the live GeoFS /map endpoint through the production client/parser and prints what
 * the data really looks like (ID stability, freshness, validity, unmapped aircraft). Usage: npm run probe:geofs [polls] [gapMs]
 */
import { GeoFsMapClient } from '../src/geofs/client.js';
import { AircraftNames } from '../src/geofs/aircraft-names.js';
import { createLogger } from '../src/logger.js';
import type { MapSnapshot } from '../src/geofs/types.js';

const polls = Number(process.argv[2] ?? 3);
const gapMs = Number(process.argv[3] ?? 10_000);
const url = process.env.GEOFS_API ?? 'https://mps.geo-fs.com/map';
const client = new GeoFsMapClient(url, 20_000);
const names = new AircraftNames(createLogger({ level: 'warn' }));

const snaps: { snap: MapSnapshot; ms: number }[] = [];
for (let i = 0; i < polls; i++) {
  const t0 = Date.now();
  const snap = await client.fetchSnapshot();
  snaps.push({ snap, ms: Date.now() - t0 });
  const o = snap.observations;
  const ages = o.filter((x) => x.serverTimeMs).map((x) => (snap.fetchedAt.getTime() - x.serverTimeMs!) / 1000).sort((a, b) => a - b);
  const q = (p: number) => ages[Math.floor(p * (ages.length - 1))]?.toFixed(1);
  console.log(`\n== poll ${i + 1}/${polls} (${snap.fetchedAt.toISOString()}, ${snap.fetchedAt.getTime()}) request ${snap.fetchedAt && snaps[i]!.ms} ms`);
  console.log(`reportedUserCount=${snap.reportedUserCount} valid=${o.length} rejected=${JSON.stringify(snap.rejected)} duplicateIds=${snap.duplicateIds}`);
  console.log(`age of server timestamp (s) vs local clock: n=${ages.length} min=${q(0)} p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${q(1)}  (negative => server/local clock skew)`);
  console.log(`guests(no acid)=${o.filter((x) => x.accountId === null).length} withBrackets=${o.filter((x) => /\[.*\]/.test(x.callsign)).length}`);
  console.log(`unknown: altitude=${o.filter((x) => x.altitudeM === null).length} speed=${o.filter((x) => x.speedKts === null).length} heading=${o.filter((x) => x.headingDeg === null).length}`);
  const unmapped = new Map<string, number>();
  for (const x of o) { const r = names.resolve(x.aircraftTypeId, x.aircraftTypeRaw); if (!r.known) unmapped.set(r.label, (unmapped.get(r.label) ?? 0) + 1); }
  console.log('unmapped aircraft types:', Object.fromEntries(unmapped));
  if (i < polls - 1) await new Promise((r) => setTimeout(r, gapMs));
}
if (snaps.length > 1) {
  const a = new Map(snaps[0]!.snap.observations.map((o) => [o.id, o]));
  const last = snaps.at(-1)!.snap;
  const b = new Map(last.observations.map((o) => [o.id, o]));
  const persisted = [...a.keys()].filter((k) => b.has(k));
  const moved = persisted.filter((k) => a.get(k)!.lat !== b.get(k)!.lat || a.get(k)!.lon !== b.get(k)!.lon);
  const csChanged = persisted.filter((k) => a.get(k)!.callsign !== b.get(k)!.callsign);
  console.log(`\n== across polls: first=${a.size} last=${b.size} idsPersisting=${persisted.length} disappeared=${a.size - persisted.length} appeared=${b.size - persisted.length} positionChanged=${moved.length} callsignChanged=${csChanged.length}`);
  const sameCs = new Map<string, string[]>();
  for (const o of last.observations) if (o.callsign !== 'Foo') sameCs.set(o.callsign.toLowerCase(), [...(sameCs.get(o.callsign.toLowerCase()) ?? []), o.id]);
  const dup = [...sameCs.entries()].filter(([, v]) => v.length > 1);
  console.log(`non-Foo callsigns shared by >1 multiplayer id: ${dup.length}`, dup.slice(0, 3));
}
const sample = snaps.at(-1)!.snap.observations.filter((o) => o.accountId !== null).slice(0, 3);
console.log('\nsample validated observations:'); console.dir(sample, { depth: 3 });
