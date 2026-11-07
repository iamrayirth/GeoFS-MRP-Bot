import pino from 'pino';
import { AlertManager } from '../../src/alerts/alert-manager.js';
import { PermanentNotifyError, type AlertPayload, type Notifier } from '../../src/alerts/types.js';
import { RuntimeConfig } from '../../src/config-service.js';
import { createRepos, type Repos } from '../../src/db/repositories.js';
import { AircraftNames } from '../../src/geofs/aircraft-names.js';
import type { MapSnapshot, Observation } from '../../src/geofs/types.js';
import { AoBoxes, CountryDirectory } from '../../src/geo/countries.js';
import { GeoEngine } from '../../src/geo/engine.js';
import { normalizeIdentifier } from '../../src/tracking/identifiers.js';
import { AircraftTracker } from '../../src/tracking/tracker.js';
import { createTestDb } from './db.js';

export const log = pino({ level: 'silent' });
let sharedGeo: GeoEngine | null = null;
export const geo = () => (sharedGeo ??= GeoEngine.load());

/** Places used by the scenarios (all verified against the bundled dataset in the geo tests). */
export const PLACE = {
  delhi: { lat: 28.6139, lon: 77.209 }, // India
  lahore: { lat: 31.5204, lon: 74.3587 }, // Pakistan
  kathmandu: { lat: 27.7172, lon: 85.324 }, // Nepal
  paris: { lat: 48.8566, lon: 2.3522 }, // France
  midAtlantic: { lat: 30, lon: -40 }, // unresolved
  siachen: { lat: 35.42, lon: 77.1 }, // India/Pakistan disputed
  mumbaiSea: { lat: 18.95, lon: 72.63 }, // Indian territorial waters
} as const;

export const t = (hhmm: string, day = '2026-01-01') => new Date(`${day}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}Z`);

export function obs(over: Partial<Observation> & { id: string; callsign: string }): Observation {
  return {
    accountId: 1, aircraftTypeId: 4, aircraftTypeRaw: '4', ...PLACE.delhi, altitudeM: 10668, headingDeg: 270, speedKts: 420, serverTimeMs: null, ...over,
  };
}
export function snapshot(observations: Observation[], at: Date): MapSnapshot {
  return { fetchedAt: at, reportedUserCount: observations.length, observations, rejected: { notObject: 0, missingId: 0, badPosition: 0, placeholderPosition: 0 }, duplicateIds: 0 };
}

export class FakeNotifier implements Notifier {
  sent: AlertPayload[] = [];
  failNext = 0;
  failPermanent = false;
  async send(p: AlertPayload) {
    if (this.failNext > 0) { this.failNext--; throw this.failPermanent ? new PermanentNotifyError('Missing Access') : new Error('Discord 503'); }
    this.sent.push(p);
  }
}

export interface Harness {
  repos: Repos; config: RuntimeConfig; tracker: AircraftTracker; manager: AlertManager; notifier: FakeNotifier;
  names: AircraftNames; dir: CountryDirectory; db: Awaited<ReturnType<typeof createTestDb>>;
  /** Feed one poll at time `at` through tracker + alert manager. */
  tick(observations: Observation[], at: Date): Promise<{ sent: number }>;
  /** Build a fresh manager+tracker over the SAME database (simulates a process restart). */
  restart(opts?: { warm?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(opts: { identifiers?: string[]; countries?: string[]; configured?: boolean; sendBackoffMs?: number } = {}): Promise<Harness> {
  const db = await createTestDb();
  const repos = createRepos(db.db);
  const config = new RuntimeConfig(repos);
  const g = geo();
  const dir = new CountryDirectory([...g.sovereigns.values()], g.territories);
  const names = new AircraftNames(log);
  for (const id of opts.identifiers ?? ['[USAF]']) await config.addIdentifier(id, normalizeIdentifier(id), 'test');
  for (const c of opts.countries ?? ['India', 'Pakistan', 'Nepal']) {
    const r = dir.lookup(c);
    if (r.kind !== 'found') throw new Error(`bad test country ${c}`);
    await config.addCountry(r.country.iso3, r.country.name, 'test');
  }
  if (opts.configured !== false) { await config.setChannel('111111111111111111'); await config.setRole('222222222222222222'); }

  const h = { repos, config, names, dir, db } as unknown as Harness;
  h.notifier = new FakeNotifier();
  let clock = new Date(0);
  const build = async (warm: boolean) => {
    h.tracker = new AircraftTracker(g, names, { staleAfterMs: 120_000 });
    h.manager = new AlertManager({ repos, config, notifier: h.notifier, aoBoxes: AoBoxes.load(dir), log, now: () => clock, sendBackoffMs: opts.sendBackoffMs ?? 0 });
    if (warm) await h.manager.warm();
  };
  await build(false);
  h.tick = async (observations, at) => {
    clock = at;
    const before = h.notifier.sent.length;
    const res = h.tracker.ingest(snapshot(observations, at), config.identifiers, at);
    await h.manager.processCycle(res.active, res.newlyInactive);
    return { sent: h.notifier.sent.length - before };
  };
  h.restart = async (o = {}) => { await config.load(); await build(o.warm ?? true); };
  h.close = () => db.close();
  return h;
}
