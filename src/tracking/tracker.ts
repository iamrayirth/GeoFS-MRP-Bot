import type { GeoEngine } from '../geo/engine.js';
import type { GeoResult } from '../geo/types.js';
import { UNRESOLVED } from '../geo/types.js';
import type { AircraftNames } from '../geofs/aircraft-names.js';
import type { MapSnapshot, Observation } from '../geofs/types.js';
import { matchIdentifiers, type IdentifierEntry } from './identifiers.js';

export interface TrackedAircraft {
  /** GeoFS multiplayer id - the one and only identity. Same callsign + different id = different aircraft. */
  id: string;
  callsign: string;
  accountId: number | null;
  aircraftTypeId: number | null;
  aircraftTypeLabel: string;
  aircraftTypeKnown: boolean;
  lat: number;
  lon: number;
  altitudeM: number | null;
  speedKts: number | null;
  headingDeg: number | null;
  serverTimeMs: number | null;
  geo: GeoResult;
  matchedIdentifiers: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  active: boolean;
  inactiveSince: Date | null;
  /** Last alert (mirrors the persistent cooldown record). */
  lastAlertAt: Date | null;
  /** Set by the alert manager each cycle from the persisted ignore list (expiry already applied). */
  ignored: boolean;
  /** Was the aircraft inside a monitored country at the previous cycle? Distinguishes ENTERED from REMAINS alerts. */
  wasInMonitored: boolean;
}

export interface IngestResult {
  active: TrackedAircraft[];
  newlyInactive: TrackedAircraft[];
  staleSkipped: number;
  newlyTracked: number;
}

export interface TrackerOptions {
  staleAfterMs: number;
  /** How long inactive aircraft stay in memory (cooldown/ignore state lives in the database regardless). */
  retainInactiveMs?: number;
}

export class AircraftTracker {
  private readonly aircraft = new Map<string, TrackedAircraft>();
  private readonly retainInactiveMs: number;

  constructor(
    private readonly geo: GeoEngine,
    private readonly names: AircraftNames,
    private readonly opts: TrackerOptions,
  ) {
    this.retainInactiveMs = opts.retainInactiveMs ?? 30 * 60_000;
  }

  /** Is this server record fresh enough to trust? Missing timestamp = unknown freshness, accepted (it is in the live map). */
  isStale(o: Observation, now: Date): boolean {
    return o.serverTimeMs !== null && now.getTime() - o.serverTimeMs > this.opts.staleAfterMs;
  }

  ingest(snapshot: MapSnapshot, identifiers: readonly IdentifierEntry[], now: Date = snapshot.fetchedAt): IngestResult {
    const seen = new Set<string>();
    let staleSkipped = 0;
    let newlyTracked = 0;

    for (const o of snapshot.observations) {
      if (this.isStale(o, now)) { staleSkipped++; continue; }
      seen.add(o.id);
      let t = this.aircraft.get(o.id);
      const type = this.names.resolve(o.aircraftTypeId, o.aircraftTypeRaw);
      if (!t) {
        t = {
          id: o.id, callsign: o.callsign, accountId: o.accountId, aircraftTypeId: o.aircraftTypeId,
          aircraftTypeLabel: type.label, aircraftTypeKnown: type.known,
          lat: o.lat, lon: o.lon, altitudeM: o.altitudeM, speedKts: o.speedKts, headingDeg: o.headingDeg, serverTimeMs: o.serverTimeMs,
          geo: this.geo.resolve(o.lat, o.lon), matchedIdentifiers: [], firstSeenAt: now, lastSeenAt: now,
          active: true, inactiveSince: null, lastAlertAt: null, ignored: false, wasInMonitored: false,
        };
        this.aircraft.set(o.id, t);
        newlyTracked++;
      } else {
        const moved = t.lat !== o.lat || t.lon !== o.lon;
        t.callsign = o.callsign; t.accountId = o.accountId; t.aircraftTypeId = o.aircraftTypeId;
        t.aircraftTypeLabel = type.label; t.aircraftTypeKnown = type.known;
        t.lat = o.lat; t.lon = o.lon; t.altitudeM = o.altitudeM; t.speedKts = o.speedKts; t.headingDeg = o.headingDeg; t.serverTimeMs = o.serverTimeMs;
        if (moved) t.geo = this.geo.resolve(o.lat, o.lon);
        t.lastSeenAt = now;
        t.active = true;
        t.inactiveSince = null;
      }
      // Recomputed every cycle so identifier removals take effect immediately.
      t.matchedIdentifiers = matchIdentifiers(t.callsign, identifiers);
    }

    const newlyInactive: TrackedAircraft[] = [];
    for (const t of this.aircraft.values()) {
      if (seen.has(t.id)) continue;
      if (t.active) { t.active = false; t.inactiveSince = now; t.wasInMonitored = false; newlyInactive.push(t); }
      else if (t.inactiveSince && now.getTime() - t.inactiveSince.getTime() > this.retainInactiveMs) this.aircraft.delete(t.id);
    }

    return { active: [...this.aircraft.values()].filter((t) => t.active), newlyInactive, staleSkipped, newlyTracked };
  }

  get(id: string): TrackedAircraft | undefined { return this.aircraft.get(id); }
  all(): TrackedAircraft[] { return [...this.aircraft.values()]; }
  get activeCount(): number { let n = 0; for (const t of this.aircraft.values()) if (t.active) n++; return n; }
  get size(): number { return this.aircraft.size; }

  findByCallsign(callsign: string, activeOnly = true): TrackedAircraft[] {
    const c = callsign.trim().toLowerCase();
    return [...this.aircraft.values()].filter((t) => (!activeOnly || t.active) && t.callsign.trim().toLowerCase() === c);
  }

  search(query: string, opts: { activeOnly?: boolean; matchingOnly?: boolean; limit?: number } = {}): TrackedAircraft[] {
    const q = query.trim().toLowerCase();
    const out: TrackedAircraft[] = [];
    for (const t of this.aircraft.values()) {
      if (opts.activeOnly !== false && !t.active) continue;
      if (opts.matchingOnly && t.matchedIdentifiers.length === 0) continue;
      if (q && !t.callsign.toLowerCase().includes(q) && !t.id.includes(q)) continue;
      out.push(t);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }
}

export { UNRESOLVED };
