/**
 * End-to-end dry run on LIVE GeoFS data: real collector, tracker, geo engine, cooldown claims in PostgreSQL and the real
 * embed builder - only the Discord delivery is replaced by console output. Nothing is simulated.
 *
 *   DATABASE_URL=postgres://... npm run dry-run -- "[" 3        # identifier(s) comma-separated, number of polls
 *   (monitors EVERY country so that any matching aircraft over land/territorial water triggers)
 */
import 'dotenv/config';
import pino from 'pino';
import { AlertManager } from '../src/alerts/alert-manager.js';
import { buildAlertMessage } from '../src/alerts/embed.js';
import type { Notifier } from '../src/alerts/types.js';
import { RuntimeConfig } from '../src/config-service.js';
import { createDb, waitForDb } from '../src/db/client.js';
import { createRepos } from '../src/db/repositories.js';
import { AircraftNames } from '../src/geofs/aircraft-names.js';
import { GeoFsMapClient } from '../src/geofs/client.js';
import { AoBoxes, CountryDirectory } from '../src/geo/countries.js';
import { GeoEngine } from '../src/geo/engine.js';
import { normalizeIdentifier } from '../src/tracking/identifiers.js';
import { AircraftTracker } from '../src/tracking/tracker.js';

const identifiers = (process.argv[2] ?? '[').split(',').map((s) => s.trim()).filter(Boolean);
const polls = Number(process.argv[3] ?? 3);
const log = pino({ level: 'warn' });
const h = createDb(process.env.DATABASE_URL!, { ssl: false, log });
await waitForDb(h, log); await h.migrate();
await h.db.execute((await import('drizzle-orm')).sql`truncate aircraft_cooldowns, aircraft_tracking, ignored_aircraft, identifiers, monitored_countries, settings`);
const repos = createRepos(h.db);
const config = new RuntimeConfig(repos);
const geo = GeoEngine.load();
const dir = new CountryDirectory([...geo.sovereigns.values()], geo.territories);
for (const id of identifiers) await config.addIdentifier(id, normalizeIdentifier(id), 'dry-run');
for (const c of dir.all) await config.addCountry(c.iso3, c.name, 'dry-run');
await config.setChannel('000000000000000001'); await config.setRole('000000000000000002');

const shown: string[] = [];
const notifier: Notifier = {
  async send(p) {
    const m = buildAlertMessage(p);
    const f = Object.fromEntries(m.embeds[0]!.toJSON().fields!.map((x) => [x.name, x.value]));
    console.log(`  ALERT [${p.kind}] ${p.callsign.padEnd(28)} id=${p.aircraftId} ${p.country.name} (${p.tier}) ${f['Aircraft']} | ${f['Altitude']} | ${f['Speed']} | ${f['Heading']}`);
    if (shown.length < 1) { shown.push('x'); console.log('\n  --- rendered message for the first alert ---'); console.log(`  content: ${m.content}  allowedMentions: ${JSON.stringify(m.allowedMentions)}`); console.log('  title:', m.embeds[0]!.toJSON().title); console.dir(f, { depth: 2 }); console.log(); }
  },
};
const tracker = new AircraftTracker(geo, new AircraftNames(log), { staleAfterMs: 120_000 });
const manager = new AlertManager({ repos, config, notifier, aoBoxes: AoBoxes.load(dir), log });
const client = new GeoFsMapClient(process.env.GEOFS_API ?? 'https://mps.geo-fs.com/map', 20_000);

for (let n = 1; n <= polls; n++) {
  const snap = await client.fetchSnapshot();
  const res = tracker.ingest(snap, config.identifiers);
  const matching = res.active.filter((a) => a.matchedIdentifiers.length);
  console.log(`poll ${n}/${polls} @ ${snap.fetchedAt.toISOString()}: ${snap.observations.length} aircraft, ${res.staleSkipped} stale skipped, ${matching.length} match ${JSON.stringify(identifiers)}, unresolved country: ${matching.filter((a) => a.geo.status === 'unresolved').length}`);
  const stats = await manager.processCycle(res.active, res.newlyInactive);
  console.log(`  -> alerts sent=${stats.alertsSent} skipped=${JSON.stringify(stats.skipped)}`);
  if (n < polls) await new Promise((r) => setTimeout(r, 10_000));
}
console.log('\ncooldown rows persisted:', (await h.db.execute((await import('drizzle-orm')).sql`select count(*)::int n from aircraft_cooldowns`) as any).rows[0].n);
await h.close();
