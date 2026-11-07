import { Client, Events, GatewayIntentBits } from 'discord.js';
import { AlertManager } from './alerts/alert-manager.js';
import { ALERT_COOLDOWN_MS, loadConfig } from './config.js';
import { RuntimeConfig } from './config-service.js';
import { createDb, waitForDb } from './db/client.js';
import { createRepos } from './db/repositories.js';
import { attachInteractionHandler } from './discord/interactions.js';
import { DiscordNotifier } from './discord/notifier.js';
import { registerCommands } from './discord/register.js';
import { AircraftNames } from './geofs/aircraft-names.js';
import { GeoFsMapClient } from './geofs/client.js';
import { AoBoxes, CountryDirectory } from './geo/countries.js';
import { GeoEngine } from './geo/engine.js';
import { HealthService } from './health.js';
import { createLogger } from './logger.js';
import { Monitor } from './monitor.js';
import { AircraftTracker } from './tracking/tracker.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function main() {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.LOG_LEVEL, pretty: cfg.LOG_PRETTY });
  const startedAt = new Date();
  log.info({ node: process.version, pollMs: cfg.POLL_INTERVAL_MS, guild: cfg.DISCORD_GUILD_ID ?? null, cooldownMs: ALERT_COOLDOWN_MS }, 'starting GeoFS MRP bot');

  // ---- database -------------------------------------------------------------------------------------------------
  const dbh = createDb(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL, log });
  await waitForDb(dbh, log);
  if (cfg.AUTO_MIGRATE) { await dbh.migrate(); log.info('database migrations applied'); }
  const repos = createRepos(dbh.db);
  const runtime = new RuntimeConfig(repos);
  await runtime.load();
  // After a restart nothing is known to be online yet.
  await repos.tracking.markAllInactive();
  log.info({ identifiers: runtime.identifiers.length, countries: runtime.countries.length, channel: runtime.channelId, role: runtime.roleId }, 'configuration restored');

  // ---- geography & aircraft names --------------------------------------------------------------------------------
  const t0 = Date.now();
  const geo = GeoEngine.load();
  const directory = new CountryDirectory([...geo.sovereigns.values()], geo.territories);
  const aoBoxes = AoBoxes.load(directory);
  log.info({ polygons: geo.polygonCount, sovereigns: geo.sovereigns.size, ms: Date.now() - t0, meta: geo.meta }, 'geodata loaded');
  const names = new AircraftNames(log, cfg.GEOFS_AIRCRAFT_LIST_URL);
  void names.refresh();

  // ---- discord --------------------------------------------------------------------------------------------------
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  client.on(Events.Error, (e) => log.error({ err: e.message }, 'discord client error'));
  client.on(Events.Warn, (m) => log.warn({ m }, 'discord warning'));
  client.rest.on('rateLimited', (info) => log.warn({ route: info.route, timeToReset: info.timeToReset, global: info.global }, 'discord rate limited (discord.js will queue and retry)'));
  const ready = new Promise<void>((res) => client.once(Events.ClientReady, () => res()));
  await client.login(cfg.DISCORD_TOKEN);
  await ready;
  log.info({ user: client.user?.tag, guilds: client.guilds.cache.size }, 'discord connected');
  if (cfg.REGISTER_COMMANDS) {
    const clientId = cfg.DISCORD_CLIENT_ID ?? client.user!.id;
    await registerCommands({ token: cfg.DISCORD_TOKEN, clientId, guildId: cfg.DISCORD_GUILD_ID, log }).catch((e) => log.error({ err: (e as Error).message }, 'command registration failed (bot continues with previously registered commands)'));
  }

  // ---- pipeline -------------------------------------------------------------------------------------------------
  const notifier = new DiscordNotifier(client, log, { guildId: cfg.DISCORD_GUILD_ID });
  const alerts = new AlertManager({ repos, config: runtime, notifier, aoBoxes, log });
  log.info({ activeCooldowns: await alerts.warm() }, 'cooldown state restored');
  const tracker = new AircraftTracker(geo, names, { staleAfterMs: cfg.STALE_AFTER_MS });
  const source = new GeoFsMapClient(cfg.GEOFS_API, cfg.HTTP_TIMEOUT_MS);
  const monitor = new Monitor(source, tracker, alerts, runtime, log, cfg.POLL_INTERVAL_MS);
  const health = new HealthService({ client, db: dbh, poller: monitor.poller, cfg, geoPolygons: geo.polygonCount });

  attachInteractionHandler(client, { cfg, log, repos, runtime, tracker, monitor, alerts, directory, geo, names, health, startedAt });
  const server = health.listen(cfg.HEALTH_PORT, log);
  monitor.start();
  log.info('monitoring started');

  // ---- maintenance ----------------------------------------------------------------------------------------------
  const timers = [
    setInterval(() => {
      const now = Date.now();
      void Promise.all([
        repos.ignores.prune(new Date(now - DAY)),
        repos.cooldowns.prune(new Date(now - 7 * DAY)),
        repos.tracking.prune(new Date(now - 7 * DAY)),
      ]).then(([i, c, t]) => log.debug({ ignores: i, cooldowns: c, tracking: t }, 'pruned old records'))
        .catch((e) => log.warn({ err: (e as Error).message }, 'prune failed'));
    }, HOUR),
    setInterval(() => void names.refresh(), 6 * HOUR),
  ];
  timers.forEach((t) => t.unref());

  // ---- shutdown -------------------------------------------------------------------------------------------------
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    timers.forEach(clearInterval);
    await monitor.stop().catch(() => undefined);
    server?.close();
    await client.destroy();
    await dbh.close().catch(() => undefined);
    log.info('bye');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection', reason: String(reason) }));
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'uncaughtException', err: err.message, stack: err.stack }));
  process.exit(1); // let the orchestrator restart us
});

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', err: (err as Error).message, stack: (err as Error).stack }));
  process.exit(1);
});
