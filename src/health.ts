import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Config } from './config.js';
import type { JsonStore } from './store/json-store.js';
import type { OspreyClient } from './osprey/client.js';
import type { Poller } from './geofs/poller.js';
import type { Log } from './logger.js';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unhealthy';
  checks: {
    storage: { ok: boolean; lastWriteAt: string | null; lastWriteError: string | null };
    osprey: { enabled: boolean; ok: boolean | null; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null };
    discord: { ok: boolean; wsPingMs: number | null };
    geofs: { ok: boolean; lastSuccessAt: string | null; ageSeconds: number | null; consecutiveFailures: number; lastError: string | null };
    geodata: { ok: boolean; polygons: number };
  };
  uptimeSeconds: number;
  memoryMb: number;
}

export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly deps: { client: Client; store: JsonStore; osprey: OspreyClient | null; poller: Poller; cfg: Config; geoPolygons: number },
  ) {}

  /**
   * unhealthy: state directory not writable or Discord not connected (restarting the process can help).
   * degraded : GeoFS unreachable/failing (an upstream problem; restarting would not help, so HTTP stays 200).
   * Osprey is optional enrichment: its state is reported but never changes the overall status.
   */
  async check(): Promise<HealthReport> {
    const { client, store, poller, cfg, osprey } = this.deps;
    const storeOk = await store.ping();
    const discordOk = client.isReady();
    const s = poller.state;
    const age = s.lastSuccessAt ? (Date.now() - s.lastSuccessAt.getTime()) / 1000 : null;
    const maxAge = (cfg.POLL_INTERVAL_MS * 3 + 30_000) / 1000;
    const geofsOk = s.consecutiveFailures < 3 && (age !== null ? age < maxAge : Date.now() - this.startedAt < 60_000);
    const status = !storeOk || !discordOk ? 'unhealthy' : !geofsOk ? 'degraded' : 'ok';
    return {
      status,
      checks: {
        storage: { ok: storeOk, lastWriteAt: store.lastWriteAt?.toISOString() ?? null, lastWriteError: store.lastWriteError },
        osprey: osprey ? { enabled: true, ...osprey.health() } : { enabled: false, ok: null, lastSuccessAt: null, consecutiveFailures: 0, lastError: null },
        discord: { ok: discordOk, wsPingMs: discordOk ? Math.round(client.ws.ping) : null },
        geofs: { ok: geofsOk, lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null, ageSeconds: age === null ? null : Math.round(age), consecutiveFailures: s.consecutiveFailures, lastError: s.lastError },
        geodata: { ok: this.deps.geoPolygons > 0, polygons: this.deps.geoPolygons },
      },
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    };
  }

  listen(port: number, log: Log): Server | null {
    if (port === 0) return null;
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/livez') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
        if (req.url === '/healthz' || req.url === '/health') {
          const r = await this.check();
          res.writeHead(r.status === 'unhealthy' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
          return;
        }
        res.writeHead(404).end();
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ status: 'unhealthy', error: (e as Error).message }));
      }
    });
    server.listen(port, () => log.info({ port }, 'health endpoint listening (/healthz, /livez)'));
    server.on('error', (e) => log.error({ err: e.message }, 'health server error'));
    return server;
  }
}
