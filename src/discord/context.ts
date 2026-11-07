import type { AlertManager } from '../alerts/alert-manager.js';
import type { RuntimeConfig } from '../config-service.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repositories.js';
import type { AircraftNames } from '../geofs/aircraft-names.js';
import type { CountryDirectory } from '../geo/countries.js';
import type { GeoEngine } from '../geo/engine.js';
import type { HealthService } from '../health.js';
import type { Log } from '../logger.js';
import type { Monitor } from '../monitor.js';
import type { AircraftTracker } from '../tracking/tracker.js';

export interface BotContext {
  cfg: Config;
  log: Log;
  repos: Repos;
  runtime: RuntimeConfig;
  tracker: AircraftTracker;
  monitor: Monitor;
  alerts: AlertManager;
  directory: CountryDirectory;
  geo: GeoEngine;
  names: AircraftNames;
  health: HealthService;
  startedAt: Date;
}
