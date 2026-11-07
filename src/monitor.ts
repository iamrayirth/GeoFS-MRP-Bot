import type { AlertManager, CycleStats } from './alerts/alert-manager.js';
import type { RuntimeConfig } from './config-service.js';
import type { GeoFsSource } from './geofs/client.js';
import { Poller } from './geofs/poller.js';
import type { MapSnapshot } from './geofs/types.js';
import type { Log } from './logger.js';
import type { AircraftTracker } from './tracking/tracker.js';

export interface MonitorStats {
  cycles: number;
  lastCycleAt: Date | null;
  lastCycle: (CycleStats & { activeAircraft: number; matching: number; staleSkipped: number; newlyInactive: number }) | null;
  totalAlertsSent: number;
}

/** Wires collector -> tracker -> alert manager. Event-driven by poll completion; never blocks the Discord event loop. */
export class Monitor {
  readonly poller: Poller;
  readonly stats: MonitorStats = { cycles: 0, lastCycleAt: null, lastCycle: null, totalAlertsSent: 0 };

  constructor(
    source: GeoFsSource,
    private readonly tracker: AircraftTracker,
    private readonly alerts: AlertManager,
    private readonly config: RuntimeConfig,
    private readonly log: Log,
    pollIntervalMs: number,
  ) {
    this.poller = new Poller(source, (s) => this.handle(s), log, { intervalMs: pollIntervalMs });
  }

  start() { this.poller.start(); }
  async stop() { await this.poller.stop(); }

  async handle(snapshot: MapSnapshot): Promise<void> {
    const t0 = Date.now();
    const res = this.tracker.ingest(snapshot, this.config.identifiers);
    const cycle = await this.alerts.processCycle(res.active, res.newlyInactive);
    this.stats.cycles++;
    this.stats.lastCycleAt = new Date();
    this.stats.totalAlertsSent += cycle.alertsSent;
    this.stats.lastCycle = {
      ...cycle,
      activeAircraft: res.active.length,
      matching: res.active.filter((a) => a.matchedIdentifiers.length > 0).length,
      staleSkipped: res.staleSkipped,
      newlyInactive: res.newlyInactive.length,
    };
    this.log.debug(
      { ms: Date.now() - t0, active: res.active.length, matching: this.stats.lastCycle.matching, stale: res.staleSkipped, rejected: snapshot.rejected, ...cycle },
      'cycle complete',
    );
  }
}
