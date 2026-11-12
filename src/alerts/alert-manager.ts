import { ALERT_COOLDOWN_MS } from '../config.js';
import type { RuntimeConfig } from '../config-service.js';
import type { Repos, TrackingRecord } from '../store/repositories.js';
import type { AoBoxes } from '../geo/countries.js';
import type { CountryRef } from '../geo/types.js';
import type { Log } from '../logger.js';
import type { TrackedAircraft } from '../tracking/tracker.js';
import { evaluateAlert, type SkipReason } from './decision.js';
import type { OspreyLookup } from '../osprey/client.js';
import { PermanentNotifyError, type AlertPayload, type Notifier, type OspreyAlertInfo } from './types.js';

export interface CycleStats {
  evaluated: number;
  alertsSent: number;
  alertsFailed: number;
  skipped: Partial<Record<SkipReason, number>>;
}

export interface AlertManagerDeps {
  repos: Repos;
  config: RuntimeConfig;
  notifier: Notifier;
  aoBoxes?: AoBoxes;
  log: Log;
  now?: () => Date;
  cooldownMs?: number;
  /** Retry holdoff for an aircraft after its alert could not be delivered. */
  sendBackoffMs?: number;
  /** Optional Osprey identity enrichment. A failure or timeout only means the alert goes out without it. */
  identity?: { lookup(q: { accountId?: number | null; callsign?: string | null }): Promise<OspreyLookup> } | null;
  identityTimeoutMs?: number;
}

export class AlertManager {
  private readonly now: () => Date;
  private readonly cooldownMs: number;
  private readonly sendBackoffMs: number;
  /** In-memory pre-check mirroring the DB cooldown table; the DB claim remains authoritative. */
  private readonly lastAlert = new Map<string, Date>();
  private readonly sendBackoff = new Map<string, Date>();
  private running = false;

  constructor(private readonly d: AlertManagerDeps) {
    this.now = d.now ?? (() => new Date());
    this.cooldownMs = d.cooldownMs ?? ALERT_COOLDOWN_MS;
    this.sendBackoffMs = d.sendBackoffMs ?? 30_000;
  }

  /** Reload cooldown state after a restart so nothing is re-alerted. */
  async warm(): Promise<number> {
    const rows = await this.d.repos.cooldowns.loadActive(this.now(), this.cooldownMs);
    for (const r of rows) this.lastAlert.set(r.aircraftId, r.lastAlertAt);
    return rows.length;
  }

  lastAlertFor(id: string): Date | null { return this.lastAlert.get(id) ?? null; }

  private pickMonitored(a: TrackedAircraft): { country: CountryRef; others: CountryRef[] } | null {
    if (a.geo.status === 'unresolved') return null;
    const monitored = a.geo.countries.find((c) => this.d.config.isMonitored(c.iso3));
    if (!monitored) return null;
    return { country: monitored, others: a.geo.countries.filter((c) => c.iso3 !== monitored.iso3) };
  }

  /**
   * Process one poll cycle. Aircraft are handled sequentially; the cycle itself is single-flight so two cycles can never
   * evaluate the same aircraft concurrently, and the DB claim protects against anything outside this process.
   */
  async processCycle(active: TrackedAircraft[], inactive: TrackedAircraft[] = []): Promise<CycleStats> {
    const stats: CycleStats = { evaluated: 0, alertsSent: 0, alertsFailed: 0, skipped: {} };
    if (this.running) { this.d.log.warn('alert cycle still running; skipping overlapping cycle'); return stats; }
    this.running = true;
    try {
      const now = this.now();
      const ignores = new Map((await this.d.repos.ignores.listActive(now)).map((r) => [r.aircraftId, r.expiresAt]));
      const toPersist: TrackingRecord[] = [];

      for (const a of active) {
        a.ignored = ignores.has(a.id);
        if (a.matchedIdentifiers.length === 0) { a.wasInMonitored = false; continue; }
        stats.evaluated++;
        try {
          const monitored = this.pickMonitored(a);
          this.crossCheck(a);
          const decision = evaluateAlert({
            active: a.active,
            matchedIdentifierCount: a.matchedIdentifiers.length,
            ignoredUntil: ignores.get(a.id) ?? null,
            countryResolved: a.geo.status !== 'unresolved',
            inMonitoredCountry: monitored !== null,
            notificationConfigured: this.d.config.isNotificationConfigured,
            lastAlertAt: this.lastAlert.get(a.id) ?? null,
            sendBackoffUntil: this.sendBackoff.get(a.id) ?? null,
            now,
          });
          if (!decision.alert) {
            stats.skipped[decision.reason] = (stats.skipped[decision.reason] ?? 0) + 1;
          } else {
            const ok = await this.fire(a, monitored!, now);
            if (ok) stats.alertsSent++; else stats.alertsFailed++;
          }
          a.wasInMonitored = monitored !== null;
        } catch (err) {
          stats.alertsFailed++;
          this.d.log.error({ err: (err as Error).message, aircraftId: a.id, callsign: a.callsign }, 'error while processing aircraft');
        }
        toPersist.push(this.toRecord(a));
      }
      for (const a of inactive) if (a.matchedIdentifiers.length) toPersist.push({ ...this.toRecord(a), active: false });

      try { await this.d.repos.tracking.upsertMany(toPersist); }
      catch (err) { this.d.log.error({ err: (err as Error).message }, 'failed to persist tracking records'); }
      return stats;
    } finally {
      this.running = false;
    }
  }

  private async fire(a: TrackedAircraft, m: { country: CountryRef; others: CountryRef[] }, now: Date): Promise<boolean> {
    const channelId = this.d.config.channelId!;
    const roleId = this.d.config.roleId!;
    // Enrich BEFORE claiming so a slow Osprey can never leave a claimed-but-unsent alert behind.
    const osprey = await this.identify(a);
    // Atomic claim BEFORE sending: only one claimant can win, across cycles, restarts and processes.
    const claim = await this.d.repos.cooldowns.tryClaim(a.id, a.callsign, m.country.iso3, now, this.cooldownMs);
    if (!claim.claimed) {
      // DB says cooldown is active although memory did not know (e.g. another process) - sync and skip.
      const row = await this.d.repos.cooldowns.get(a.id);
      if (row) this.lastAlert.set(a.id, row.lastAlertAt);
      this.d.log.debug({ aircraftId: a.id }, 'cooldown claim refused by database');
      return false;
    }
    const payload: AlertPayload = {
      kind: a.wasInMonitored ? 'remains' : 'entered',
      aircraftId: a.id, callsign: a.callsign, matchedIdentifiers: [...a.matchedIdentifiers],
      aircraftTypeLabel: a.aircraftTypeLabel, lat: a.lat, lon: a.lon, altitudeM: a.altitudeM, speedKts: a.speedKts, headingDeg: a.headingDeg,
      country: m.country, otherClaimants: m.others, territory: a.geo.territory, tier: a.geo.tier!, snapped: a.geo.snapped,
      detectedAt: now, osprey, channelId, roleId,
    };
    try {
      await this.d.notifier.send(payload);
    } catch (err) {
      // Delivery failed: give the cooldown back so the alert is retried (after a short holdoff), not silently lost.
      await this.d.repos.cooldowns.release(a.id, now, claim.previous).catch((e) => this.d.log.error({ err: (e as Error).message }, 'cooldown rollback failed'));
      this.sendBackoff.set(a.id, new Date(now.getTime() + this.sendBackoffMs));
      this.d.log.error({ err: (err as Error).message, permanent: err instanceof PermanentNotifyError, aircraftId: a.id, callsign: a.callsign }, 'alert delivery failed; cooldown rolled back');
      return false;
    }
    this.lastAlert.set(a.id, now);
    this.sendBackoff.delete(a.id);
    a.lastAlertAt = now;
    this.d.log.info(
      { event: 'alert_sent', aircraftId: a.id, callsign: a.callsign, country: m.country.iso3, tier: a.geo.tier, kind: payload.kind, identifiers: a.matchedIdentifiers },
      'alert sent',
    );
    return true;
  }

  /** Osprey lookup bounded by a short timeout; any problem degrades to "no enrichment", never to a lost alert. */
  private async identify(a: TrackedAircraft): Promise<OspreyAlertInfo> {
    const id = this.d.identity;
    if (!id) return { status: 'disabled' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<OspreyLookup>((res) => { timer = setTimeout(() => res({ status: 'unavailable', error: 'timeout' }), this.d.identityTimeoutMs ?? 2000); });
      const r = await Promise.race([id.lookup({ accountId: a.accountId, callsign: a.callsign }), timeout]);
      return r.status === 'ok' ? { status: 'ok', identity: r.identity } : { status: r.status === 'not_found' ? 'not_found' : 'unavailable' };
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message, aircraftId: a.id }, 'osprey enrichment failed; sending alert without it');
      return { status: 'unavailable' };
    } finally { clearTimeout(timer); }
  }

  /** Sanity check against the user-supplied coarse boxes. Logs only; never changes or suppresses the polygon result. */
  private crossCheck(a: TrackedAircraft) {
    const ao = this.d.aoBoxes;
    if (!ao || a.geo.status !== 'resolved') return;
    const c = a.geo.countries[0]!;
    if (ao.contains(c.iso3, a.lat, a.lon) === false) {
      this.d.log.warn({ event: 'aobox_mismatch', aircraftId: a.id, country: c.iso3, territory: a.geo.territory, lat: a.lat, lon: a.lon }, 'polygon result lies outside the coarse bounding box for that country (informational)');
    }
  }

  private toRecord(a: TrackedAircraft): TrackingRecord {
    return {
      aircraftId: a.id, callsign: a.callsign, accountId: a.accountId, aircraftTypeId: a.aircraftTypeId,
      matchedIdentifiers: a.matchedIdentifiers, lat: a.lat, lon: a.lon, altitudeM: a.altitudeM, speedKts: a.speedKts, headingDeg: a.headingDeg,
      countryIso3: a.geo.status === 'resolved' ? a.geo.countries[0]!.iso3 : null,
      firstSeenAt: a.firstSeenAt, lastSeenAt: a.lastSeenAt, active: a.active, lastAlertAt: a.lastAlertAt,
    };
  }
}
