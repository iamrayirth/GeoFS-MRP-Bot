import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Config } from './config.js';
import type { DbHandle } from './db/client.js';
import type { Poller } from './geofs/poller.js';
import type { Log } from './logger.js';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unhealthy';
  checks: {
    database: { ok: boolean };
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
    private readonly deps: { client: Client; db: DbHandle; poller: Poller; cfg: Config; geoPolygons: number },
  ) {}

  /**
   * unhealthy: database unreachable or Discord not connected (restarting the process can help).
   * degraded : GeoFS unreachable/failing (an upstream problem; restarting would not help, so HTTP stays 200).
   */
  async check(): Promise<HealthReport> {
    const { client, db, poller, cfg } = this.deps;
    const dbOk = await db.ping();
    const discordOk = client.isReady();
    const s = poller.state;
    const age = s.lastSuccessAt ? (Date.now() - s.lastSuccessAt.getTime()) / 1000 : null;
    const maxAge = (cfg.POLL_INTERVAL_MS * 3 + 30_000) / 1000;
    const geofsOk = s.consecutiveFailures < 3 && (age !== null ? age < maxAge : Date.now() - this.startedAt < 60_000);
    const status = !dbOk || !discordOk ? 'unhealthy' : !geofsOk ? 'degraded' : 'ok';
    return {
      status,
      checks: {
        database: { ok: dbOk },
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
