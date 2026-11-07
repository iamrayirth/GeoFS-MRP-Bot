import type { Log } from '../logger.js';
import type { GeoFsSource } from './client.js';
import type { MapSnapshot } from './types.js';

export interface PollerState {
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalPolls: number;
  totalFailures: number;
  lastDurationMs: number | null;
  lastUserCount: number | null;
}

export interface PollerOptions {
  intervalMs: number;
  maxBackoffMs?: number;
  random?: () => number;
}

/** Single-flight polling loop (setTimeout chain, never overlapping) with exponential backoff + jitter on failure. */
export class Poller {
  readonly state: PollerState = {
    lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
    totalPolls: 0, totalFailures: 0, lastDurationMs: null, lastUserCount: null,
  };
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly source: GeoFsSource,
    private readonly onSnapshot: (s: MapSnapshot) => Promise<void>,
    private readonly log: Log,
    private readonly opts: PollerOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** Delay before the next attempt. Exposed for tests. */
  nextDelayMs(): number {
    const { intervalMs, maxBackoffMs = 60_000, random = Math.random } = this.opts;
    const f = this.state.consecutiveFailures;
    if (f === 0) return intervalMs;
    const backoff = Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(f, 10));
    return Math.round(backoff * (0.9 + random() * 0.2));
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.inFlight = this.tick().finally(() => { this.inFlight = null; }); }, delay);
  }

  async tick(): Promise<void> {
    const t0 = Date.now();
    this.state.lastAttemptAt = new Date(t0);
    this.state.totalPolls++;
    try {
      const snap = await this.source.fetchSnapshot();
      this.state.lastDurationMs = Date.now() - t0;
      this.state.lastSuccessAt = new Date();
      this.state.lastUserCount = snap.observations.length;
      if (this.state.consecutiveFailures > 0) this.log.info({ after: this.state.consecutiveFailures }, 'GeoFS polling recovered');
      this.state.consecutiveFailures = 0;
      this.state.lastError = null;
      try { await this.onSnapshot(snap); }
      catch (e) { this.log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'snapshot handler failed'); }
    } catch (e) {
      this.state.consecutiveFailures++;
      this.state.totalFailures++;
      this.state.lastError = (e as Error).message;
      this.log.warn({ err: this.state.lastError, consecutiveFailures: this.state.consecutiveFailures, nextInMs: this.nextDelayMs() }, 'GeoFS poll failed');
    }
    const elapsed = Date.now() - t0;
    this.schedule(this.state.consecutiveFailures === 0 ? Math.max(1000, this.opts.intervalMs - elapsed) : this.nextDelayMs());
  }
}
